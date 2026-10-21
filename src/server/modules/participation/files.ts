import { createHash, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  fileLimits,
  UploadInput,
  normalizeFilePath,
  type UploadInputValue,
  type FilePageValue,
} from '../../../contracts/files.js';
import { lockAttempt } from '../../application/attempt.js';
import type { ActorContext } from '../publication/actor.js';
import { identityOf } from '../publication/actor.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { safeError, PublicationError } from '../publication/errors.js';
import type { Transactions } from '../../db/postgres.js';
import { canonicalAttemptKey } from '../publication/input.js';
import { FileStorage, FileError, verifyBytes } from './file-storage.js';
import {
  fileGuard,
  uploadRow,
  uploadStatus,
  authorizeUpload,
  type UploadRow,
} from './file-context.js';
import { responseBudget, RetrievalError } from './retrieval.js';

export class ArtifactFiles {
  constructor(
    private readonly database: Transactions,
    private readonly storage?: FileStorage,
  ) {}
  private store() {
    if (!this.storage) throw new FileError('file_storage_unavailable');
    return this.storage;
  }
  async create(actorContext: ActorContext, value: unknown) {
    if (!Value.Check(UploadInput, value)) throw new PublicationError('invalid_input');
    const input = structuredClone(value) as UploadInputValue;
    try {
      input.path = normalizeFilePath(input.path);
    } catch {
      throw new PublicationError('invalid_input');
    }
    input.idempotency_key = input.idempotency_key.toLowerCase();
    input.target.resource_id = input.target.resource_id.toLowerCase();
    input.sha256 = input.sha256.toLowerCase();
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          'file-upload-v1',
          input.target.kind,
          input.target.resource_id,
          input.path,
          input.size,
          input.sha256,
          input.media_type,
        ]),
      )
      .digest('hex');
    await this.store().check();
    return this.run(async () =>
      this.database.transaction(async (tx) => {
        await lockAttempt(
          tx,
          identityOf(actorContext).participantId,
          'file.upload',
          input.idempotency_key,
        );
        const actor = await lockActor(tx, actorContext);
        await fileGuard(tx);
        const prior = (
          await tx.query<{ id: string }>(
            'SELECT id FROM loom.file_uploads WHERE participant_id=$1 AND idempotency_key=$2',
            [actor.participantId, input.idempotency_key],
          )
        ).rows[0];
        if (prior) {
          const row = await uploadRow(tx, prior.id, actor.participantId);
          if (row.request_digest !== digest) throw new PublicationError('idempotency_conflict');
          return uploadStatus(row);
        }
        await authorizeUpload(tx, actor, input.target);
        const counts = (
          await tx.query<{
            total: string;
            owned: string;
            active: string;
            bytes: string;
            owner_bytes: string;
          }>(
            `SELECT count(*)::text AS total,
        count(*) FILTER(WHERE participant_id=$1)::text AS owned,
        count(*) FILTER(WHERE participant_id=$1 AND state IN ('waiting','uploading','staged','finalizing','quarantined') AND reserved)::text AS active,
        coalesce(sum(size*2) FILTER(WHERE reserved),0)::text AS bytes,
        coalesce(sum(size*2) FILTER(WHERE reserved AND participant_id=$1),0)::text AS owner_bytes FROM loom.file_uploads`,
            [actor.participantId],
          )
        ).rows[0]!;
        if (
          Number(counts.total) >= fileLimits.sessions ||
          Number(counts.owned) >= fileLimits.ownerSessions ||
          Number(counts.active) >= fileLimits.active ||
          Number(counts.bytes) + input.size * 2 > fileLimits.communityBytes ||
          Number(counts.owner_bytes) + input.size * 2 > fileLimits.ownerBytes
        )
          throw new FileError('file_capacity');
        const id = randomUUID();
        await tx.query(
          `INSERT INTO loom.file_uploads(id,participant_id,idempotency_key,request_digest,target_kind,target_id,path,size,sha256,media_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            actor.participantId,
            input.idempotency_key,
            digest,
            input.target.kind,
            input.target.resource_id,
            input.path,
            input.size,
            input.sha256,
            input.media_type,
          ],
        );
        return uploadStatus(await uploadRow(tx, id, actor.participantId));
      }),
    );
  }
  async status(actor: ActorContext, id: string) {
    return this.run(() =>
      this.database.transaction(async (tx) => {
        const owner = await lockActor(tx, actor);
        return uploadStatus(await uploadRow(tx, canonicalAttemptKey(id), owner.participantId));
      }),
    );
  }
  async find(actor: ActorContext, key: string) {
    return this.run(() =>
      this.database.transaction(async (tx) => {
        await lockAttempt(
          tx,
          identityOf(actor).participantId,
          'file.upload',
          canonicalAttemptKey(key),
        );
        const owner = await lockActor(tx, actor);
        const row = (
          await tx.query<{ id: string }>(
            'SELECT id FROM loom.file_uploads WHERE participant_id=$1 AND idempotency_key=$2',
            [owner.participantId, key.toLowerCase()],
          )
        ).rows[0];
        return row
          ? uploadStatus(await uploadRow(tx, row.id, owner.participantId))
          : { operation_state: 'not_recorded' as const };
      }),
    );
  }
  private async claim(actorContext: ActorContext, id: string, final: boolean) {
    return this.database.transaction(async (tx) => {
      const actor = await lockActor(tx, actorContext);
      await fileGuard(tx);
      const row = await uploadRow(tx, id, actor.participantId);
      await authorizeUpload(tx, actor, { kind: row.target_kind, resource_id: row.target_id });
      if (row.state === 'prepared' || (!final && row.stage_version)) return { row, work: false };
      if (
        !row.prepared_valid ||
        (!final && !row.upload_valid) ||
        ['expired', 'cleaning'].includes(row.state)
      )
        throw new FileError('file_expired');
      if (row.leased) throw new FileError('file_busy');
      if (final && !row.stage_version) throw new FileError('file_not_prepared');
      await tx.query(
        `UPDATE loom.file_uploads SET state=$2,lease_until=clock_timestamp()+$3*interval '1 second' WHERE id=$1`,
        [id, final ? 'finalizing' : 'uploading', fileLimits.leaseSeconds],
      );
      return { row, work: true };
    });
  }
  private async finish(actor: ActorContext, row: UploadRow, version: string, final: boolean) {
    return this.database.transaction(async (tx) => {
      const owner = await lockActor(tx, actor);
      await fileGuard(tx);
      const current = await uploadRow(tx, row.id, owner.participantId);
      await authorizeUpload(tx, owner, { kind: row.target_kind, resource_id: row.target_id });
      if (current.state === 'prepared' || (!final && current.stage_version))
        return uploadStatus(current);
      if (current.state !== (final ? 'finalizing' : 'uploading'))
        throw new FileError('file_expired');
      await tx.query(
        `UPDATE loom.file_uploads SET ${final ? 'final_version' : 'stage_version'}=$2,state=$3,lease_until=NULL WHERE id=$1`,
        [row.id, version, final ? 'prepared' : 'staged'],
      );
      return uploadStatus(await uploadRow(tx, row.id, owner.participantId));
    });
  }
  async upload(actor: ActorContext, id: string, bytes: Buffer) {
    return this.run(async () => {
      const store = this.store();
      id = canonicalAttemptKey(id);
      // The HTTP connection may close while these bytes wait for a DB connection.
      // Own a buffer slot before the first wait, through final association.
      return store.admitted(async () => {
        // Verify input even on retry; changed bytes are never an exact upload retry.
        const status = await this.database.transaction(async (tx) => {
          const owner = await lockActor(tx, actor);
          return uploadRow(tx, id, owner.participantId);
        });
        verifyBytes(bytes, status);
        const { row, work } = await this.claim(actor, id, false);
        if (!work) return uploadStatus(row);
        const version = await store.native((signal) => store.put(id, false, bytes, row, signal));
        return this.finish(actor, row, version, false);
      });
    });
  }
  async finalize(actor: ActorContext, id: string) {
    return this.run(async () => {
      const store = this.store();
      id = canonicalAttemptKey(id);
      const { row, work } = await this.claim(actor, id, true);
      if (!work) return uploadStatus(row);
      const version = await store.bounded(async (signal) => {
        const bytes = await store.read(id, false, row.stage_version!, row, signal);
        return store.put(id, true, bytes, row, signal);
      });
      return this.finish(actor, row, version, true);
    });
  }
  async cleanup(actorContext: ActorContext) {
    return this.run(async () => {
      const store = this.store();
      const candidates = await this.database.transaction(async (tx) => {
        const actor = await lockActor(tx, actorContext);
        await fileGuard(tx);
        const rows = (
          await tx.query<{ id: string; published: boolean }>(
            `SELECT u.id,EXISTS(SELECT 1 FROM loom.file_contexts f WHERE f.upload_id=u.id) AS published
        FROM loom.file_uploads u WHERE participant_id=$1 AND reserved AND prepared_expires_at<clock_timestamp()
        AND (lease_until IS NULL OR lease_until<clock_timestamp()-interval '1 hour')
        AND NOT EXISTS(SELECT 1 FROM loom.file_contexts f WHERE f.upload_id=u.id)
        ORDER BY prepared_expires_at,id LIMIT $2`,
            [actor.participantId, fileLimits.cleanupItems],
          )
        ).rows;
        for (const row of rows)
          await tx.query(
            "UPDATE loom.file_uploads SET state='cleaning',lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",
            [row.id],
          );
        return rows;
      });
      let removed = 0,
        quarantined = 0;
      for (const row of candidates) {
        try {
          await store.bounded(async (signal) => {
            await store.remove(row.id, false, signal);
            await store.remove(row.id, true, signal);
          });
          await this.database.transaction(async (tx) => {
            await fileGuard(tx);
            await tx.query(
              "UPDATE loom.file_uploads SET state='expired',reserved=false,lease_until=NULL WHERE id=$1 AND state='cleaning'",
              [row.id],
            );
          });
          removed++;
        } catch {
          await this.database.transaction(async (tx) => {
            await fileGuard(tx);
            await tx.query(
              "UPDATE loom.file_uploads SET state='quarantined',lease_until=clock_timestamp() WHERE id=$1 AND state='cleaning'",
              [row.id],
            );
          });
          quarantined++;
        }
      }
      return { removed, quarantined };
    });
  }
  async manifest(
    actorContext: ActorContext,
    artifact: string,
    revision: string,
    options: { prefix?: string; cursor?: string; limit?: string; max_response_bytes?: string } = {},
  ): Promise<FilePageValue> {
    artifact = canonicalAttemptKey(artifact);
    revision = canonicalAttemptKey(revision);
    let prefix = '';
    try {
      prefix = options.prefix ? normalizeFilePath(options.prefix) : '';
    } catch {
      throw new PublicationError('invalid_input');
    }
    const budget = responseBudget(options.max_response_bytes),
      limit = Number(options.limit ?? 12);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new PublicationError('invalid_input');
    // The fixed manifest has at most16 members. Cursor is an offset scoped to the
    // exact manifest/prefix, never a hidden storage or source locator.
    let start = 0;
    if (options.cursor) {
      try {
        const token = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()) as unknown[];
        if (
          token.length !== 5 ||
          token[0] !== identityOf(actorContext).participantId ||
          token[1] !== artifact ||
          token[2] !== revision ||
          token[3] !== prefix ||
          !Number.isInteger(token[4]) ||
          Number(token[4]) < 0 ||
          Number(token[4]) > fileLimits.entries
        )
          throw new Error();
        start = Number(token[4]);
      } catch {
        throw new RetrievalError('invalid_cursor');
      }
    }
    return this.run(() =>
      this.database.transaction(async (tx) => {
        await lockActor(tx, actorContext);
        await lockContext(tx, artifact, 'resolution', ['artifact']);
        await requireRevision(tx, artifact, revision);
        const rows = (
          await tx.query<{
            id: string;
            path: string;
            size: number;
            sha256: string;
            media_type: string;
          }>(
            `SELECT f.id,f.path,u.size,u.sha256,u.media_type
        FROM loom.file_contexts f JOIN loom.file_uploads u ON u.id=f.upload_id
        WHERE f.artifact_id=$1 AND f.revision_id=$2 ORDER BY f.path COLLATE "C" LIMIT $3`,
            [artifact, revision, fileLimits.entries + 1],
          )
        ).rows;
        if (rows.length > fileLimits.entries) throw new FileError('file_capacity');
        const entries = new Map<string, FilePageValue['items'][number]>();
        for (const row of rows) {
          const remainder = prefix
            ? row.path.startsWith(prefix + '/')
              ? row.path.slice(prefix.length + 1)
              : null
            : row.path;
          if (!remainder) continue;
          const slash = remainder.indexOf('/');
          if (slash >= 0) {
            const path = (prefix ? prefix + '/' : '') + remainder.slice(0, slash);
            entries.set(path, { kind: 'folder', path });
          } else
            entries.set(row.path, {
              kind: 'file',
              path: row.path,
              file_id: row.id,
              size: row.size,
              sha256: row.sha256,
              media_type: row.media_type,
              type_evidence: 'declared',
              download_url: `/api/v1/artifacts/${artifact}/revisions/${revision}/files/${row.id}/download`,
            });
        }
        const items = [...entries.values()].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        const cursor = (index: number) =>
          index < items.length
            ? Buffer.from(
                JSON.stringify([
                  identityOf(actorContext).participantId,
                  artifact,
                  revision,
                  prefix,
                  index,
                ]),
              ).toString('base64url')
            : null;
        const page: FilePageValue = {
          artifact_id: artifact,
          revision_id: revision,
          prefix,
          items: [],
          next_cursor: cursor(start),
          complete: start >= items.length,
          availability: 'declared_not_probed',
          max_response_bytes: budget,
        };
        for (let index = start; index < items.length && page.items.length < limit; index++) {
          const candidate = {
            ...page,
            items: [...page.items, items[index]!],
            next_cursor: cursor(index + 1),
            complete: index + 1 >= items.length,
          };
          const size = Buffer.byteLength(JSON.stringify(candidate));
          if (size > budget) {
            if (!page.items.length) throw new RetrievalError('response_budget_too_small', size);
            break;
          }
          Object.assign(page, candidate);
        }
        return page;
      }),
    );
  }
  async download(actor: ActorContext, artifact: string, revision: string, file: string) {
    return this.run(async () => {
      const store = this.store();
      artifact = canonicalAttemptKey(artifact);
      revision = canonicalAttemptKey(revision);
      file = canonicalAttemptKey(file);
      const authorize = () =>
        this.database.transaction(async (tx) => {
          await lockActor(tx, actor);
          await lockContext(tx, artifact, 'resolution', ['artifact']);
          await requireRevision(tx, artifact, revision);
          const context = (
            await tx.query<{ upload_id: string; path: string }>(
              'SELECT upload_id,path FROM loom.file_contexts WHERE artifact_id=$1 AND revision_id=$2 AND id=$3',
              [artifact, revision, file],
            )
          ).rows[0];
          if (!context) throw new PublicationError('unavailable');
          const row = await uploadRow(tx, context.upload_id);
          if (!row.final_version) throw new FileError('file_storage_unavailable');
          return { row, path: context.path };
        });
      const selected = await authorize();
      // Retain admission while verified bytes wait for the final authorization.
      // Releasing at the end of S3 IO would allow unbounded queued file buffers.
      const bytes = await store.bounded(
        (signal) =>
          store.read(selected.row.id, true, selected.row.final_version!, selected.row, signal),
        async () => {
          await authorize();
        },
      );
      return { bytes, path: selected.path };
    });
  }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FileError || error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
}
