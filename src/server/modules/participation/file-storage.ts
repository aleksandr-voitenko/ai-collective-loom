import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  S3Client,
  GetBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { fileLimits } from '../../../contracts/files.js';

export class FileError extends Error {
  constructor(
    readonly code:
      | 'file_storage_unavailable'
      | 'file_capacity'
      | 'file_not_prepared'
      | 'file_expired'
      | 'file_mismatch'
      | 'file_busy',
    readonly definitive = false,
  ) {
    super(
      {
        file_storage_unavailable:
          'The exact stored file is unavailable. Retain the operation and retry explicitly.',
        file_capacity:
          'The synthetic file capacity was reached. Recovery and inspection remain available.',
        file_not_prepared: 'Every declared file must be prepared before publication.',
        file_expired:
          'This file preparation expired. Reconcile publication before explicitly correcting the draft.',
        file_mismatch:
          'The bytes do not match the retained length and SHA-256. Reselect the original file or create a new intent.',
        file_busy: 'This file operation is still processing. Check status before retrying.',
      }[code],
    );
  }
}
export type StorageConfiguration = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  stagingBucket: string;
  finalBucket: string;
};
export type ByteIdentity = { size: number; sha256: string };
export function verifyBytes(bytes: Uint8Array, expected: ByteIdentity) {
  if (
    bytes.byteLength !== expected.size ||
    bytes.byteLength > fileLimits.fileBytes ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw new FileError('file_mismatch');
}
/** One native provider boundary. No latest-version download or filesystem fallback. */
export class FileStorage {
  readonly client: S3Client;
  private active = 0;
  constructor(readonly configuration: StorageConfiguration) {
    const endpoint = new URL(configuration.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
      configuration.stagingBucket === configuration.finalBucket
    )
      throw new Error(
        'File storage requires distinct private synthetic buckets on a local endpoint.',
      );
    this.client = new S3Client({
      endpoint: configuration.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  async check() {
    for (const Bucket of [this.configuration.stagingBucket, this.configuration.finalBucket]) {
      try {
        const result = await this.client.send(new GetBucketVersioningCommand({ Bucket }), {
          abortSignal: AbortSignal.timeout(fileLimits.transferMs),
        });
        if (result.Status !== 'Enabled') throw new FileError('file_storage_unavailable');
      } catch {
        throw new FileError('file_storage_unavailable');
      }
    }
  }
  bucket(final: boolean) {
    return final ? this.configuration.finalBucket : this.configuration.stagingBucket;
  }
  key(id: string) {
    return 'artifact-files-v1/' + id;
  }
  async admitted<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= fileLimits.active) throw new FileError('file_capacity');
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
  async native<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await work(AbortSignal.timeout(fileLimits.transferMs));
    } catch (error) {
      if (error instanceof FileError) throw error;
      throw new FileError('file_storage_unavailable');
    }
  }
  async bounded<T>(
    work: (signal: AbortSignal) => Promise<T>,
    complete?: (value: T) => Promise<void>,
  ): Promise<T> {
    return this.admitted(async () => {
      const value = await this.native(work);
      // Retain buffer admission through application completion. Its authority
      // and database errors are separate from native provider failures.
      await complete?.(value);
      return value;
    });
  }
  async versions(id: string, final: boolean, signal: AbortSignal) {
    const response = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket(final),
        Prefix: this.key(id),
        MaxKeys: fileLimits.versions + 1,
      }),
      { abortSignal: signal },
    );
    const versions = (response.Versions ?? []).filter((v) => v.Key === this.key(id));
    if (
      response.IsTruncated ||
      versions.length > fileLimits.versions ||
      (response.DeleteMarkers ?? []).length
    )
      throw new FileError('file_storage_unavailable');
    if (versions.some((v) => !v.VersionId || v.VersionId === 'null'))
      throw new FileError('file_storage_unavailable');
    return versions.map((v) => v.VersionId!);
  }
  async read(
    id: string,
    final: boolean,
    version: string,
    expected: ByteIdentity,
    signal: AbortSignal,
  ) {
    if (!version || version === 'null') throw new FileError('file_storage_unavailable');
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket(final), Key: this.key(id), VersionId: version }),
      { abortSignal: signal },
    );
    if (response.VersionId !== version || !response.Body) {
      (response.Body as Readable | undefined)?.destroy();
      throw new FileError('file_storage_unavailable');
    }
    if (response.ContentLength !== expected.size) {
      (response.Body as Readable).destroy();
      throw new FileError('file_mismatch');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > expected.size || length > fileLimits.fileBytes)
          throw new FileError('file_mismatch');
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      (response.Body as Readable).destroy();
    }
    const bytes = Buffer.concat(chunks, length);
    verifyBytes(bytes, expected);
    return bytes;
  }
  /** All uncertain candidates are verified against the immutable intent. A newer
   * staging overwrite can never substitute for a selected or matching version. */
  async reconcile(id: string, final: boolean, expected: ByteIdentity, signal: AbortSignal) {
    const versions = await this.versions(id, final, signal);
    for (const version of versions.sort()) {
      try {
        await this.read(id, final, version, expected, signal);
        return version;
      } catch (error) {
        if (!(error instanceof FileError) || error.code !== 'file_mismatch') throw error;
      }
    }
    if (versions.length) throw new FileError('file_mismatch');
    return undefined;
  }
  async put(
    id: string,
    final: boolean,
    bytes: Uint8Array,
    expected: ByteIdentity,
    signal: AbortSignal,
  ) {
    verifyBytes(bytes, expected);
    const found = await this.reconcile(id, final, expected, signal);
    if (found) return found;
    try {
      const response = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket(final),
          Key: this.key(id),
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: 'application/octet-stream',
          IfNoneMatch: '*',
          Metadata: { 'loom-upload': id, sha256: expected.sha256 },
        }),
        { abortSignal: signal },
      );
      if (!response.VersionId || response.VersionId === 'null')
        throw new FileError('file_storage_unavailable');
      await this.read(id, final, response.VersionId, expected, signal);
      return response.VersionId;
    } catch {
      // A lost response is not permission to write another native version.
      const recovered = await this.reconcile(id, final, expected, signal);
      if (!recovered) throw new FileError('file_storage_unavailable');
      return recovered;
    }
  }
  async remove(id: string, final: boolean, signal: AbortSignal) {
    for (const version of await this.versions(id, final, signal))
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket(final),
          Key: this.key(id),
          VersionId: version,
        }),
        { abortSignal: signal },
      );
    if ((await this.versions(id, final, signal)).length)
      throw new FileError('file_storage_unavailable');
  }
}
