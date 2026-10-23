import type { Transactions, SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { PublicationError, safeError } from '../publication/errors.js';
import {
  ParticipationRetrieval,
  RetrievalError,
  fit,
  responseBudget,
} from '../participation/retrieval.js';
import {
  fileTextLimits as limits,
  type FileTextOptions,
  type FileTextValue,
  type FileSearchOptions,
  type FileSearchStatusValue,
  type FileSearchPageValue,
  type FileSearchResultValue,
  type FileTextHealthValue,
} from '../../../contracts/file-text.js';
import { eligibleSql, excerpt, normalizeSearch, SearchError } from './search.js';
import { typedSources } from './worker.js';
import { fileDiscoveryGuard } from './file-worker.js';
import { FileTokens } from './file-tokens.js';

export function fileTextUrl(
  kind: 'artifact' | 'contribution',
  resource: string,
  revision: string,
  file: string,
) {
  return `/api/v1/${kind === 'artifact' ? 'artifacts' : 'contributions'}/${resource}/revisions/${revision}/${kind === 'artifact' ? 'files' : 'attachments'}/${file}`;
}
export const fileBrowserUrl = (kind: string, resource: string, revision: string, file: string) =>
  `/loom/file/${kind}/${resource}/${revision}/${file}`;
async function boundary(tx: SqlTransaction) {
  return (
    await tx.query<{
      generation: number;
      boundary: string;
      worker: 'unknown' | 'online' | 'offline';
      capacity_limited: boolean;
    }>(
      `SELECT f.generation,f.capacity_limited,
    json_build_array(f.generation,f.index_version,s.visibility_version,c.shared_position,o.version)::text AS boundary,
    CASE WHEN f.heartbeat_at IS NULL THEN 'unknown' WHEN f.heartbeat_at>clock_timestamp()-interval '45 seconds' THEN 'online' ELSE 'offline' END AS worker
    FROM loom.file_text_state f CROSS JOIN loom.search_state s CROSS JOIN loom.community_clocks c CROSS JOIN loom.organization_state o WHERE f.id=1 AND s.id=1 AND c.id=1 AND o.id=1`,
      [],
    )
  ).rows[0]!;
}
async function population(tx: SqlTransaction) {
  const n = Number(
    (
      await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM (${typedSources} LIMIT 5001) s`,
        [],
      )
    ).rows[0]!.n,
  );
  if (n > 5000) throw new SearchError('search_work_limit');
}
async function status(
  tx: SqlTransaction,
  state: Awaited<ReturnType<typeof boundary>>,
): Promise<FileSearchStatusValue> {
  const missing = (
    await tx.query<{ missing: boolean }>(
      `${eligibleSql} SELECT EXISTS(SELECT 1 FROM eligible e
    JOIN loom.file_contexts f ON COALESCE(f.artifact_id,f.contribution_id)=e.id AND f.revision_id=e.current_revision_id
    LEFT JOIN loom.file_text_documents d ON d.file_id=f.id AND d.generation=$1 WHERE d.file_id IS NULL) AS missing`,
      [state.generation],
    )
  ).rows[0]!.missing;
  return {
    worker: state.worker,
    coverage: !missing && state.worker === 'online' ? 'retained_prefixes_ready' : 'incomplete',
    population: 'current_eligible_file_contexts',
    qualification: 'supported_utf8_prefixes_only',
  };
}

export class FileText {
  private readonly tokens = new FileTokens();
  private readonly reads: ParticipationRetrieval;
  constructor(private readonly database: Transactions) {
    this.reads = new ParticipationRetrieval(database);
  }
  private async run<T>(work: (tx: SqlTransaction) => Promise<T>) {
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('statement_timeout','2500ms',true),set_config('lock_timeout','1500ms',true),set_config('transaction_timeout','15000ms',true)",
          [],
        );
        return work(tx);
      });
    } catch (error) {
      if (error instanceof RetrievalError || error instanceof SearchError) throw error;
      return safeError(error);
    }
  }
  preview(
    actor: ActorContext,
    kind: 'artifact' | 'contribution',
    resource: string,
    revision: string,
    file: string,
    options: FileTextOptions = {},
    projection: 'preview' | 'status' = 'preview',
  ) {
    const budget =
      options.max_response_bytes === undefined
        ? limits.responseBytes
        : responseBudget(options.max_response_bytes);
    if (budget > limits.responseBytes) throw new PublicationError('invalid_input');
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      await lockContext(tx, resource, 'resolution', [kind]);
      await requireRevision(tx, resource, revision);
      const selected = (
        await tx.query<{ path: string; size: number }>(
          `SELECT f.path,u.size FROM loom.file_contexts f JOIN loom.file_uploads u ON u.id=f.upload_id
        WHERE f.id=$1 AND f.revision_id=$2 AND f.${kind === 'artifact' ? 'artifact_id' : 'contribution_id'}=$3`,
          [file, revision, resource],
        )
      ).rows[0];
      if (!selected) throw new PublicationError('unavailable');
      const state = await boundary(tx);
      const job = (
        await tx.query<{ state: FileTextValue['processing']; reason: string | null }>(
          'SELECT state,reason FROM loom.file_text_jobs WHERE file_id=$1 AND generation=$2',
          [file, state.generation],
        )
      ).rows[0];
      const doc = (
        await tx.query<{
          state: 'complete' | 'partial' | 'unsupported';
          body: string;
          reason: string | null;
          sha256: string;
          native_version: string;
        }>(
          'SELECT state,body,reason,sha256,native_version FROM loom.file_text_documents WHERE file_id=$1 AND generation=$2',
          [file, state.generation],
        )
      ).rows[0];
      const binding = JSON.stringify([
        authority.participantId,
        'file-preview-v1',
        kind,
        resource.toLowerCase(),
        revision.toLowerCase(),
        file.toLowerCase(),
      ]);
      const exact = JSON.stringify([state.generation, doc?.sha256, doc?.native_version]);
      const saved = options.cursor
        ? this.tokens.decode(options.cursor, binding, exact, limits.outputBytes + 1)
        : undefined;
      const chars = Array.from(doc?.body ?? ''),
        offset = saved?.offset ?? 0;
      if (offset > chars.length) throw new SearchError('search_changed');
      const expires = saved?.expires ?? Date.now() + limits.cursorSeconds * 1000;
      const processing = doc?.state ?? job?.state ?? 'not_discovered';
      const base = fileTextUrl(kind, resource, revision, file);
      const view: FileTextValue = {
        resource_id: resource,
        revision_id: revision,
        file_id: file,
        owner_kind: kind,
        path: selected.path,
        representation: 'literal-utf8-v1',
        processing,
        reason:
          doc?.reason ?? job?.reason ?? (!job && state.capacity_limited ? 'job_capacity' : null),
        worker: state.worker,
        indexing:
          processing === 'unsupported'
            ? 'not_supported'
            : processing === 'failed'
              ? 'failed'
              : doc
                ? 'indexed'
                : 'pending',
        retained_bytes: Buffer.byteLength(doc?.body ?? ''),
        original_bytes: selected.size,
        text: null,
        next_cursor: null,
        retained_text_complete: false,
        source_complete: processing === 'complete',
        download_url: base + '/download',
        context_url: `/api/v1/resources/${resource}/revisions/${revision}`,
        browser_context_url: `/loom/resource/${resource}/${revision}`,
        max_response_bytes: budget,
      };
      if (projection === 'preview' && doc && doc.state !== 'unsupported') {
        let end = Math.min(chars.length, offset + limits.pageCharacters);
        for (;;) {
          view.text = chars.slice(offset, end).join('');
          view.retained_text_complete = end === chars.length;
          view.next_cursor =
            end < chars.length ? this.tokens.encode(binding, exact, end, expires) : null;
          if (Buffer.byteLength(JSON.stringify(view)) <= budget) break;
          if (end === offset) fit(view, budget);
          end = offset + Math.floor((end - offset) / 2);
        }
        if (end === offset && end < chars.length)
          throw new RetrievalError('response_budget_too_small', budget + 1);
      }
      if ((await boundary(tx)).generation !== state.generation)
        throw new SearchError('search_changed');
      return fit(view, budget);
    });
  }
  status(actor: ActorContext) {
    return this.run(async (tx) => {
      await lockActor(tx, actor);
      await tx.query(
        'SELECT pg_advisory_xact_lock_shared($1::integer,$2::integer)',
        [0x4c4f4f4d, 1],
      );
      await population(tx);
      return status(tx, await boundary(tx));
    });
  }
  search(actor: ActorContext, options: FileSearchOptions) {
    const normalized = normalizeSearch(options),
      budget = responseBudget(options.max_response_bytes),
      limit = Number(options.limit ?? 12);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new SearchError('invalid_search');
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      // Stabilize placement before population selection; per-result exact guards
      // additionally serialize authority/revision changes with response creation.
      await tx.query(
        'SELECT pg_advisory_xact_lock_shared($1::integer,$2::integer)',
        [0x4c4f4f4d, 1],
      );
      await population(tx);
      if (normalized.scope.topic)
        await lockContext(tx, normalized.scope.topic, 'resolution', ['area']);
      const state = await boundary(tx),
        binding = JSON.stringify([authority.participantId, 'simple-file-contents-v1', normalized]);
      const saved = options.cursor
        ? this.tokens.decode(options.cursor, binding, state.boundary, 200)
        : undefined;
      const nodes = (
        await tx.query<{ n: number }>(
          "SELECT numnode(plainto_tsquery('pg_catalog.simple',$1)) AS n",
          [normalized.q],
        )
      ).rows[0]!.n;
      if (!nodes || nodes > 16) throw new SearchError('invalid_search');
      const s = normalized.scope;
      const matches = (
        await tx.query<{
          id: string;
          file_id: string;
          revision_id: string;
          path: string;
          body: string;
          state: 'complete' | 'partial';
          search_kind: 'discussion' | 'comment' | 'artifact';
        }>(
          `${eligibleSql}
        SELECT e.id,f.id AS file_id,f.revision_id,f.path,d.body,d.state,e.search_kind FROM eligible e
        JOIN loom.file_contexts f ON COALESCE(f.artifact_id,f.contribution_id)=e.id AND f.revision_id=e.current_revision_id
        JOIN loom.file_text_documents d ON d.file_id=f.id AND d.generation=$1
        WHERE d.state IN ('complete','partial') AND d.document @@ plainto_tsquery('pg_catalog.simple',$2)
        AND ($3::uuid IS NULL OR CASE WHEN $4::boolean THEN $3=ANY(e.path) ELSE e.area_id=$3 END)
        AND ($5::text IS NULL OR e.search_kind=$5) AND ($6::uuid IS NULL OR e.original_author_id=$6)
        AND ($7::timestamptz IS NULL OR e.created_at>=$7) AND ($8::timestamptz IS NULL OR e.created_at<$8)
        ORDER BY ts_rank(d.document,plainto_tsquery('pg_catalog.simple',$2)) DESC,f.id LIMIT 201`,
          [
            state.generation,
            normalized.q,
            s.topic,
            s.descendants,
            s.kind,
            s.author,
            s.from,
            s.before,
          ],
        )
      ).rows;
      let offset = saved?.offset ?? 0;
      const expires = saved?.expires ?? Date.now() + limits.cursorSeconds * 1000,
        window = matches.slice(0, 200);
      const view: FileSearchPageValue = {
        items: [],
        query: normalized.q,
        scope: normalized.scope,
        indexing: await status(tx, state),
        ranking: 'simple-file-contents-v1',
        selection: 'bounded_current_file_relevance',
        next_cursor: null,
        window_exhausted: false,
        selection_limited: matches.length > 200,
        corpus_exhaustive: false,
        limit,
        max_response_bytes: budget,
        expires_at: new Date(expires).toISOString(),
      };
      const cursor = (n: number) =>
        n < window.length ? this.tokens.encode(binding, state.boundary, n, expires) : null;
      for (const row of window.slice(offset, offset + limit)) {
        const source = await this.reads.resource(tx, authority, row.id, row.revision_id);
        const chain = await lockContext(tx, row.id, 'resolution');
        if (chain[0]!.current_revision_id !== row.revision_id)
          throw new SearchError('search_changed');
        const areas = (
          await tx.query<{ id: string; title: string }>(
            'SELECT id,title FROM loom.areas WHERE id=ANY($1::uuid[])',
            [chain.filter((r) => r.kind === 'area').map((r) => r.id)],
          )
        ).rows;
        const kind = row.search_kind === 'artifact' ? 'artifact' : 'contribution';
        const base = fileTextUrl(kind, row.id, row.revision_id, row.file_id);
        const item: FileSearchResultValue = {
          file_id: row.file_id,
          source_resource_id: row.id,
          revision_id: row.revision_id,
          owner_kind: kind,
          kind: row.search_kind,
          path: row.path,
          title: source.title,
          author: source.author,
          publisher: source.publisher,
          published_at: source.created_at,
          area_id: source.area_id,
          location: chain
            .filter((r) => r.kind === 'area')
            .reverse()
            .map((r) => areas.find((a) => a.id === r.id)!)
            .filter(Boolean),
          discussion_id: source.discussion_id,
          parent_id: source.parent_id,
          matching_field: 'file_contents',
          excerpt: excerpt(row.body, normalized.q),
          extraction: row.state,
          indexing: 'indexed',
          preview_url: base + '/text',
          browser_url: fileBrowserUrl(kind, row.id, row.revision_id, row.file_id),
          download_url: base + '/download',
          context_url: source.discussion_id
            ? `/api/v1/contributions/${row.id}/context`
            : `/api/v1/resources/${row.id}`,
          browser_context_url: source.discussion_id
            ? `/loom/discussion/${source.discussion_id}?focus=${row.id}`
            : `/loom/resource/${row.id}/${row.revision_id}`,
        };
        view.items.push(item);
        view.next_cursor = cursor(offset + 1);
        if (Buffer.byteLength(JSON.stringify(view)) > budget) {
          view.items.pop();
          if (!view.items.length) fit({ ...view, items: [item] }, budget);
          break;
        }
        offset++;
      }
      view.next_cursor = cursor(offset);
      view.window_exhausted = view.next_cursor === null;
      if ((await boundary(tx)).boundary !== state.boundary) throw new SearchError('search_changed');
      return fit(view, budget);
    });
  }
  rebuild(actor: ActorContext, expected: number) {
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      if (!authority.administrator) throw new PublicationError('forbidden');
      await fileDiscoveryGuard(tx);
      const state = (
        await tx.query<{ generation: number }>(
          'SELECT generation FROM loom.file_text_state WHERE id=1 FOR UPDATE',
          [],
        )
      ).rows[0]!;
      if (state.generation !== expected && state.generation !== expected + 1)
        throw new SearchError('search_changed');
      if (state.generation === expected)
        await tx.query(
          'UPDATE loom.file_text_state SET generation=generation+1,index_version=index_version+1 WHERE id=1',
          [],
        );
      return { generation: state.generation === expected ? expected + 1 : state.generation };
    });
  }
  retry(actor: ActorContext, file: string, claimGeneration: number) {
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      if (!authority.administrator) throw new PublicationError('forbidden');
      const row = (
        await tx.query<{ claim_generation: number; state: string }>(
          'SELECT claim_generation,state FROM loom.file_text_jobs WHERE file_id=$1 FOR UPDATE',
          [file],
        )
      ).rows[0];
      if (
        !row ||
        row.claim_generation < claimGeneration ||
        (row.claim_generation === claimGeneration && row.state !== 'failed')
      )
        throw new SearchError('search_changed');
      if (row.claim_generation === claimGeneration && row.state === 'failed') {
        await tx.query(
          "UPDATE loom.file_text_jobs SET state='queued',attempts=0,reason=NULL,claim_generation=claim_generation+1,due_at=clock_timestamp() WHERE file_id=$1",
          [file],
        );
        await tx.query(
          'UPDATE loom.file_text_state SET index_version=index_version+1 WHERE id=1',
          [],
        );
      }
      return { accepted: true as const };
    });
  }
  health(actor: ActorContext, after?: string): Promise<FileTextHealthValue> {
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      if (!authority.administrator) throw new PublicationError('forbidden');
      const state = await boundary(tx);
      const bytes = (
        await tx.query<{ retained_bytes: string; reserved_bytes: string }>(
          'SELECT retained_bytes::text,reserved_bytes::text FROM loom.file_text_state WHERE id=1',
          [],
        )
      ).rows[0]!;
      const rows = (
        await tx.query<{ file_id: string; claim_generation: number; reason: string | null }>(
          "SELECT file_id,claim_generation,reason FROM loom.file_text_jobs WHERE state='failed' AND generation=$1 AND ($2::uuid IS NULL OR file_id>$2) ORDER BY file_id LIMIT 26",
          [state.generation, after ?? null],
        )
      ).rows;
      return {
        generation: state.generation,
        worker: state.worker,
        retained_bytes: Number(bytes.retained_bytes),
        reserved_bytes: Number(bytes.reserved_bytes),
        items: rows.slice(0, 25),
        next_after: rows.length > 25 ? rows[24]!.file_id : null,
      };
    });
  }
}
