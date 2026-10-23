import { randomUUID } from 'node:crypto';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { FileStorage, FileError } from '../participation/file-storage.js';
import { fileTextLimits as limits } from '../../../contracts/file-text.js';
import { decodeFileText, type DecodedFile } from './file-decoder.js';

export type FileClaim = {
  file_id: string;
  generation: number;
  claim_generation: number;
  owner: string;
};
export type FileInput = {
  file_id: string;
  resource_id: string;
  revision_id: string;
  upload_id: string;
  path: string;
  size: number;
  sha256: string;
  media_type: string;
  final_version: string;
};
export async function fileDiscoveryGuard(tx: SqlTransaction) {
  await tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [0x4c4f4f4d, 16]);
}
export async function fileInput(tx: SqlTransaction, file: string) {
  const row = (
    await tx.query<FileInput>(
      `SELECT f.id AS file_id,COALESCE(f.artifact_id,f.contribution_id) AS resource_id,
    f.revision_id,f.upload_id,f.path,u.size,u.sha256,u.media_type,u.final_version
    FROM loom.file_contexts f JOIN loom.file_uploads u ON u.id=f.upload_id WHERE f.id=$1`,
      [file],
    )
  ).rows[0];
  if (!row?.final_version) throw new FileError('file_storage_unavailable');
  return row;
}

/** Independent controlled derivatives. Suppressed contexts may be processed
 * nonpublicly; every participant projection separately checks current authority. */
export class FileTextWorker {
  readonly owner = randomUUID();
  private active = 0;
  constructor(
    private readonly database: Transactions,
    private readonly storage: FileStorage,
  ) {}
  private run<T>(work: (tx: SqlTransaction) => Promise<T>) {
    return this.database.transaction(async (tx) => {
      await tx.query(
        "SELECT set_config('statement_timeout','2500ms',true),set_config('lock_timeout','1500ms',true),set_config('transaction_timeout','15000ms',true)",
        [],
      );
      return work(tx);
    });
  }
  discover() {
    return this.run(async (tx) => {
      await fileDiscoveryGuard(tx);
      const { generation } = (
        await tx.query<{ generation: number }>(
          'SELECT generation FROM loom.file_text_state WHERE id=1',
          [],
        )
      ).rows[0]!;
      const count = Number(
        (await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM loom.file_text_jobs', []))
          .rows[0]!.n,
      );
      // The finite publication-context population and indexed anti-join avoid a
      // UUID high-water gap. Committed jobs are the resumable discovery position.
      // At capacity, missing contexts must not starve retained stale-generation
      // jobs behind them. Keep their recovery independent of new-job admission.
      const rows = (
        await tx.query<{ id: string }>(
          `SELECT f.id FROM loom.file_contexts f
        LEFT JOIN loom.file_text_jobs j ON j.file_id=f.id
        WHERE (j.file_id IS NULL AND $3::boolean) OR j.generation<>$1 ORDER BY f.id LIMIT $2`,
          [generation, limits.discovery, count < limits.jobs],
        )
      ).rows;
      let released = 0,
        enqueued = 0,
        added = 0;
      for (const row of rows) {
        const old = (
          await tx.query<{ reserved_bytes: number }>(
            'SELECT reserved_bytes FROM loom.file_text_jobs WHERE file_id=$1 FOR UPDATE',
            [row.id],
          )
        ).rows[0];
        if (!old && count + added >= limits.jobs) continue;
        if (!old) added++;
        released += old?.reserved_bytes ?? 0;
        await tx.query(
          `INSERT INTO loom.file_text_jobs(file_id,generation) VALUES($1,$2)
          ON CONFLICT(file_id) DO UPDATE SET generation=$2,state='queued',claim_generation=loom.file_text_jobs.claim_generation+1,
          attempts=0,owner=NULL,lease_until=NULL,reserved_bytes=0,reason=NULL,due_at=clock_timestamp()`,
          [row.id, generation],
        );
        enqueued++;
      }
      const limited =
        count + added >= limits.jobs &&
        (
          await tx.query<{ missing: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM loom.file_contexts f
            LEFT JOIN loom.file_text_jobs j ON j.file_id=f.id WHERE j.file_id IS NULL) AS missing`,
            [],
          )
        ).rows[0]!.missing;
      await tx.query(
        `UPDATE loom.file_text_state SET heartbeat_at=clock_timestamp(),reserved_bytes=reserved_bytes-$1,capacity_limited=$2 WHERE id=1`,
        [released, limited],
      );
      return enqueued;
    });
  }
  claim(limit: number = limits.concurrency) {
    if (!Number.isInteger(limit) || limit < 1 || limit > limits.concurrency)
      throw new Error('Invalid file claim batch.');
    return this.run(async (tx) => {
      const rows = (
        await tx.query<{
          file_id: string;
          generation: number;
          claim_generation: number;
          attempts: number;
          reserved_bytes: number;
        }>(
          `SELECT * FROM loom.file_text_jobs
        WHERE generation=(SELECT generation FROM loom.file_text_state WHERE id=1)
        AND ((state='queued' AND due_at<=clock_timestamp()) OR (state='running' AND lease_until<=clock_timestamp()))
        ORDER BY file_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        )
      ).rows;
      const claims: FileClaim[] = [];
      // Jobs before state, consistently with discovery, retry and finalization.
      const current = (
        await tx.query<{ generation: number }>(
          'SELECT generation FROM loom.file_text_state WHERE id=1 FOR UPDATE',
          [],
        )
      ).rows[0]!;
      for (const row of rows) {
        if (row.generation !== current.generation) continue;
        if (row.attempts >= limits.attempts) {
          await tx.query(
            "UPDATE loom.file_text_jobs SET state='failed',reason='lease_expired',owner=NULL,lease_until=NULL,reserved_bytes=0 WHERE file_id=$1",
            [row.file_id],
          );
          await tx.query(
            'UPDATE loom.file_text_state SET reserved_bytes=reserved_bytes-$1,index_version=index_version+1 WHERE id=1',
            [row.reserved_bytes],
          );
          continue;
        }
        const retained =
          (
            await tx.query<{ n: number }>(
              'SELECT octet_length(body) AS n FROM loom.file_text_documents WHERE file_id=$1',
              [row.file_id],
            )
          ).rows[0]?.n ?? 0;
        const reservation = limits.outputBytes - retained;
        const delta = reservation - row.reserved_bytes;
        const admitted = await tx.query(
          `UPDATE loom.file_text_state SET reserved_bytes=reserved_bytes+$1
          WHERE id=1 AND retained_bytes+reserved_bytes+$1<=$2`,
          [delta, limits.derivedBytes],
        );
        if (!admitted.rowCount) {
          await tx.query(
            "UPDATE loom.file_text_jobs SET state='failed',reason='derived_capacity',owner=NULL,lease_until=NULL,reserved_bytes=0 WHERE file_id=$1",
            [row.file_id],
          );
          await tx.query(
            'UPDATE loom.file_text_state SET reserved_bytes=reserved_bytes-$1,index_version=index_version+1 WHERE id=1',
            [row.reserved_bytes],
          );
          continue;
        }
        const claim = (
          await tx.query<FileClaim>(
            `UPDATE loom.file_text_jobs SET state='running',owner=$2,claim_generation=claim_generation+1,
          attempts=attempts+1,reason=NULL,reserved_bytes=$3,lease_until=clock_timestamp()+make_interval(secs=>$4)
          WHERE file_id=$1 RETURNING file_id,generation,claim_generation,owner`,
            [row.file_id, this.owner, reservation, limits.leaseSeconds],
          )
        ).rows[0]!;
        claims.push(claim);
      }
      return claims;
    });
  }
  renew(claim: FileClaim) {
    return this.run(async (tx) => {
      await tx.query('SELECT file_id FROM loom.file_text_jobs WHERE file_id=$1 FOR UPDATE', [
        claim.file_id,
      ]);
      return (
        (
          await tx.query(
            `UPDATE loom.file_text_jobs SET lease_until=clock_timestamp()+make_interval(secs=>$4)
        WHERE file_id=$1 AND owner=$2 AND claim_generation=$3 AND state='running' AND lease_until>clock_timestamp()
        AND generation=(SELECT generation FROM loom.file_text_state WHERE id=1)`,
            [claim.file_id, claim.owner, claim.claim_generation, limits.leaseSeconds],
          )
        ).rowCount === 1
      );
    });
  }
  async prepare(claim: FileClaim) {
    const input = await this.run((tx) => fileInput(tx, claim.file_id));
    return this.storage.bounded(async (signal) => {
      const bytes = await this.storage.read(
        input.upload_id,
        true,
        input.final_version,
        input,
        signal,
      );
      return { input, decoded: decodeFileText(bytes, input.path, input.media_type) };
    });
  }
  finalize(claim: FileClaim, prepared: { input: FileInput; decoded: DecodedFile }) {
    return this.run(async (tx) => {
      const i = prepared.input;
      await tx.query('SELECT id FROM loom.resources WHERE id=$1 FOR SHARE', [i.resource_id]);
      await tx.query('SELECT id FROM loom.revisions WHERE id=$1 FOR SHARE', [i.revision_id]);
      // Contexts are immutable and loom_app deliberately has no UPDATE privilege
      // (including row-lock privilege). Source/revision guards serialize lifecycle;
      // re-read the exact immutable context without widening that SQL authority.
      const input = await fileInput(tx, i.file_id);
      if (JSON.stringify(input) !== JSON.stringify(i)) throw new FileError('file_mismatch');
      const job = (
        await tx.query<{
          owner: string;
          claim_generation: number;
          state: string;
          generation: number;
          reserved_bytes: number;
        }>('SELECT * FROM loom.file_text_jobs WHERE file_id=$1 FOR UPDATE', [claim.file_id])
      ).rows[0]!;
      await tx.query('SELECT id FROM loom.file_text_state WHERE id=1 FOR UPDATE', []);
      // Time and generation are observed after all waits. Rebuild/lease loss can
      // never publish old output, including when COMMIT acknowledgement is lost.
      const valid = (
        await tx.query(
          `SELECT 1 FROM loom.file_text_jobs j CROSS JOIN loom.file_text_state s
        WHERE j.file_id=$1 AND j.owner=$2 AND j.claim_generation=$3 AND j.state='running'
        AND j.lease_until>clock_timestamp() AND j.generation=$4 AND s.generation=j.generation`,
          [claim.file_id, claim.owner, claim.claim_generation, claim.generation],
        )
      ).rowCount;
      if (!valid) return false;
      const oldBytes =
        (
          await tx.query<{ n: number }>(
            'SELECT octet_length(body) AS n FROM loom.file_text_documents WHERE file_id=$1',
            [i.file_id],
          )
        ).rows[0]?.n ?? 0;
      const d = prepared.decoded;
      await tx.query(
        `INSERT INTO loom.file_text_documents(file_id,generation,contract,upload_id,native_version,sha256,original_bytes,state,reason,body,document)
        VALUES($1,$2,'literal-utf8-v1',$3,$4,$5,$6,$7,$8,$9,to_tsvector('pg_catalog.simple',normalize($9,NFC)))
        ON CONFLICT(file_id) DO UPDATE SET generation=EXCLUDED.generation,contract=EXCLUDED.contract,upload_id=EXCLUDED.upload_id,
        native_version=EXCLUDED.native_version,sha256=EXCLUDED.sha256,original_bytes=EXCLUDED.original_bytes,state=EXCLUDED.state,reason=EXCLUDED.reason,body=EXCLUDED.body,document=EXCLUDED.document`,
        [
          i.file_id,
          claim.generation,
          i.upload_id,
          i.final_version,
          i.sha256,
          i.size,
          d.state,
          d.reason,
          d.text,
        ],
      );
      await tx.query(
        'UPDATE loom.file_text_state SET retained_bytes=retained_bytes+$1,reserved_bytes=reserved_bytes-$2,index_version=index_version+1 WHERE id=1',
        [Buffer.byteLength(d.text) - oldBytes, job.reserved_bytes],
      );
      await tx.query(
        'UPDATE loom.file_text_jobs SET state=$2,reason=$3,owner=NULL,lease_until=NULL,reserved_bytes=0 WHERE file_id=$1',
        [i.file_id, d.state, d.reason],
      );
      return true;
    });
  }
  fail(claim: FileClaim, reason: 'storage' | 'byte_mismatch' | 'processing' = 'processing') {
    return this.run(async (tx) => {
      const job = (
        await tx.query<{ reserved_bytes: number }>(
          'SELECT reserved_bytes FROM loom.file_text_jobs WHERE file_id=$1 FOR UPDATE',
          [claim.file_id],
        )
      ).rows[0];
      await tx.query('SELECT id FROM loom.file_text_state WHERE id=1 FOR UPDATE', []);
      const result = await tx.query(
        `UPDATE loom.file_text_jobs SET state=CASE WHEN attempts>=$5 THEN 'failed' ELSE 'queued' END,
        owner=NULL,lease_until=NULL,reserved_bytes=0,reason=$6,due_at=clock_timestamp()+make_interval(secs=>power(2,attempts-1)::int)
        WHERE file_id=$1 AND owner=$2 AND claim_generation=$3 AND generation=$4 AND state='running'
        AND lease_until>clock_timestamp() AND generation=(SELECT generation FROM loom.file_text_state WHERE id=1)`,
        [
          claim.file_id,
          claim.owner,
          claim.claim_generation,
          claim.generation,
          limits.attempts,
          reason,
        ],
      );
      if (result.rowCount)
        await tx.query(
          'UPDATE loom.file_text_state SET reserved_bytes=reserved_bytes-$1,index_version=index_version+1 WHERE id=1',
          [job!.reserved_bytes],
        );
      return result.rowCount === 1;
    });
  }
  async process(claim: FileClaim) {
    if (this.active >= limits.concurrency) return false;
    this.active++;
    const renewal = setInterval(() => {
      void this.renew(claim).catch(() => {});
    }, 10000);
    try {
      return await this.finalize(claim, await this.prepare(claim));
    } catch (error) {
      await this.fail(
        claim,
        error instanceof FileError
          ? error.code === 'file_mismatch'
            ? 'byte_mismatch'
            : 'storage'
          : 'processing',
      );
      return false;
    } finally {
      clearInterval(renewal);
      this.active--;
    }
  }
  async tick() {
    await this.discover();
    if (this.active >= limits.concurrency) return 0;
    const claims = await this.claim(limits.concurrency - this.active);
    await Promise.all(claims.map((claim) => this.process(claim)));
    return claims.length;
  }
}
