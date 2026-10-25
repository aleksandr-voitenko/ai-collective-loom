import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { safeError, PublicationError } from '../publication/errors.js';
import { ParticipationRetrieval, RetrievalError, fit, responseBudget } from './retrieval.js';
import {
  declaration,
  lockReferencePlan,
  referenceTarget,
  type ReferenceRow,
} from './reference-context.js';
import {
  TargetInput,
  IncomingInput,
  ReferencePageInput,
  referenceLimits,
  type IncomingOptions,
  type ReferencePageOptions,
  type ReferencePageView,
  type ReferenceEntryView,
  type ResolvedTargetView,
} from '../../../contracts/references.js';
import type { ReferenceTargetValue, ResourceView } from '../../../contracts/participation.js';
import { canonicalReferenceTarget } from '../../../contracts/authored.js';

export class ReferenceError extends Error {
  constructor(readonly code: 'references_changed' | 'reference_work_limit') {
    super(
      code === 'references_changed'
        ? 'This reference view changed or expired. Refresh references to start again.'
        : 'This reference request exceeds the synthetic work limit. Retry a bounded view.',
    );
  }
}
type Cursor = {
  binding: string;
  boundary: string;
  after: [string, string, string] | null;
  expires: number;
};
const contextUrl = (source: ResourceView) =>
  source.kind === 'summary'
    ? `/loom/resource/${source.resource_id}`
    : source.discussion_id
      ? `/loom/discussion/${source.discussion_id}?focus=${source.resource_id}`
      : `/loom/resource/${source.resource_id}`;
function canonicalTarget(target: ReferenceTargetValue): ReferenceTargetValue {
  try {
    return canonicalReferenceTarget(target);
  } catch {
    throw new PublicationError('invalid_input');
  }
}
async function boundary(tx: SqlTransaction) {
  return (
    await tx.query<{ value: string }>(
      `SELECT json_build_array(c.shared_position,s.visibility_version,o.version)::text AS value
    FROM loom.community_clocks c CROSS JOIN loom.search_state s CROSS JOIN loom.organization_state o
    WHERE c.id=1 AND s.id=1 AND o.id=1`,
      [],
    )
  ).rows[0]!.value;
}

export class RecordedReferences {
  private readonly key = randomBytes(32);
  private readonly reads: ParticipationRetrieval;
  constructor(private readonly database: Transactions) {
    this.reads = new ParticipationRetrieval(database);
  }
  private encode(value: Cursor) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  private decode(value: string): Cursor {
    try {
      if (Buffer.byteLength(value) > referenceLimits.cursorBytes) throw new Error();
      const bytes = Buffer.from(value, 'base64url'),
        decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const saved = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      ) as Cursor;
      if (
        !Number.isFinite(saved.expires) ||
        saved.expires <= Date.now() ||
        !saved.after ||
        saved.after.length !== 3 ||
        [saved.after[0], saved.after[2]].some((id) => !/^[0-9a-f-]{36}$/.test(id)) ||
        !['main', 'change_note'].includes(saved.after[1]!)
      )
        throw new Error();
      return saved;
    } catch {
      throw new ReferenceError('references_changed');
    }
  }
  private async run<T>(work: (tx: SqlTransaction) => Promise<T>) {
    try {
      return await this.database.transaction(async (tx) => {
        // Each page uses one authorized snapshot. Conflicting updates before a row
        // guard cause serialization failure; after it, the writer waits for this read.
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
        await tx.query("SET LOCAL statement_timeout='2500ms'", []);
        return work(tx);
      });
    } catch (error) {
      if (error instanceof ReferenceError || error instanceof RetrievalError) throw error;
      const code = (error as { code?: string })?.code;
      if (['40001', '40P01', '55P03'].includes(code ?? ''))
        throw new ReferenceError('references_changed');
      if (code === '57014') throw new ReferenceError('reference_work_limit');
      return safeError(error);
    }
  }
  private async resolve(
    tx: SqlTransaction,
    actor: Awaited<ReturnType<typeof lockActor>>,
    target: ReferenceTargetValue,
  ): Promise<ResolvedTargetView> {
    const selected = await referenceTarget(tx, target);
    const representation = await this.reads.resource(
      tx,
      actor,
      selected.source.id,
      selected.revision,
    );
    return {
      state: 'available',
      target,
      scope: target.file_id ? 'file' : target.revision_id ? 'revision' : 'resource',
      representation,
      browser_url: target.file_id
        ? `/loom/file/${target.kind}/${target.resource_id}/${target.revision_id}/${target.file_id}`
        : target.kind === 'discussion'
          ? `/loom/discussion/${target.resource_id}`
          : `/loom/resource/${target.resource_id}${target.revision_id ? '/' + target.revision_id : ''}`,
      context_url: contextUrl(representation),
    };
  }
  target(actor: ActorContext, input: ReferenceTargetValue) {
    if (!Value.Check(TargetInput, input)) throw new PublicationError('invalid_input');
    // Link resolution can supply the contextual identity without a path. Only
    // this read fills it from membership; authored declarations always include it.
    const lookup = input.file_id !== undefined && input.path === undefined;
    if (lookup && (!input.revision_id || !['artifact', 'contribution'].includes(input.kind)))
      throw new PublicationError('invalid_input');
    return this.run(async (tx) => {
      const authority = await lockActor(tx, actor);
      await lockReferencePlan(tx, [input.resource_id.toLowerCase()]);
      let path = input.path;
      if (lookup) {
        // Check owning publication/revision before looking up its immutable member.
        await referenceTarget(tx, {
          kind: input.kind,
          resource_id: input.resource_id.toLowerCase(),
          revision_id: input.revision_id!.toLowerCase(),
        });
        path = (
          await tx.query<{ path: string }>(
            `SELECT path FROM loom.file_contexts WHERE id=$1 AND revision_id=$2 AND ${input.kind === 'artifact' ? 'artifact_id' : 'contribution_id'}=$3`,
            [input.file_id!, input.revision_id!, input.resource_id],
          )
        ).rows[0]?.path;
        if (path === undefined) throw new PublicationError('unavailable');
      }
      const target = canonicalTarget({ ...input, ...(path === undefined ? {} : { path }) });
      return fit(await this.resolve(tx, authority, target), 131072);
    });
  }
  incoming(actor: ActorContext, input: IncomingOptions) {
    if (!Value.Check(IncomingInput, input)) throw new PublicationError('invalid_input');
    return this.page(
      actor,
      {
        target: canonicalTarget(input),
        history: input.history ?? 'current',
        relationship: input.relationship ?? null,
      },
      input,
    );
  }
  outgoing(actor: ActorContext, source: string, revision: string, options: ReferencePageOptions) {
    if (!Value.Check(ReferencePageInput, options)) throw new PublicationError('invalid_input');
    return this.page(actor, { source, revision }, options);
  }
  private page(
    actorContext: ActorContext,
    selection:
      | { source: string; revision: string }
      | { target: ReferenceTargetValue; history: 'current' | 'all'; relationship: string | null },
    options: ReferencePageOptions,
  ) {
    const budget = responseBudget(options.max_response_bytes),
      limit = Number(options.limit ?? 12);
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext),
        state = await boundary(tx),
        binding = createHash('sha256')
          .update(
            JSON.stringify([
              actor.participantId,
              selection,
              'source_revision_uuid_then_field_then_reference_uuid',
            ]),
          )
          .digest('hex');
      const saved = options.cursor ? this.decode(options.cursor) : undefined;
      if (saved && (saved.binding !== binding || saved.boundary !== state))
        throw new ReferenceError('references_changed');
      const after = saved?.after ?? null,
        expires = saved?.expires ?? Date.now() + referenceLimits.cursorSeconds * 1000;
      const incoming = 'target' in selection;
      // Upgrade fixtures and retained legacy readers may still use a pre-file schema.
      const fileSchema =
        incoming &&
        !!(
          await tx.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='loom.revision_references'::regclass AND attname='target_file_id' AND NOT attisdropped) AS present",
            [],
          )
        ).rows[0]?.present;
      if (incoming && selection.target.file_id && !fileSchema)
        throw new PublicationError('unavailable');
      const candidates = (
        await tx.query<ReferenceRow>(
          incoming
            ? `SELECT rr.* FROM loom.revision_references rr
        JOIN loom.resources s ON s.id=rr.source_id
        WHERE rr.target_id=$1 AND rr.target_revision_id IS NOT DISTINCT FROM $2::uuid
        ${fileSchema ? 'AND rr.target_file_id IS NOT DISTINCT FROM $6::uuid' : ''}
        AND ($3::uuid IS NULL OR (rr.revision_id,rr.source_field,rr.reference_id)>($3::uuid,$4::text,$5::uuid))
        ORDER BY rr.revision_id,rr.source_field,rr.reference_id LIMIT 101`
            : `SELECT rr.* FROM loom.revision_references rr WHERE rr.source_id=$1 AND rr.revision_id=$2
        AND ($3::uuid IS NULL OR (rr.revision_id,rr.source_field,rr.reference_id)>($3::uuid,$4::text,$5::uuid))
        ORDER BY rr.revision_id,rr.source_field,rr.reference_id LIMIT 101`,
          incoming
            ? [
                selection.target.resource_id,
                selection.target.revision_id ?? null,
                after?.[0] ?? null,
                after?.[1] ?? null,
                after?.[2] ?? null,
                ...(fileSchema ? [selection.target.file_id ?? null] : []),
              ]
            : [
                selection.source,
                selection.revision,
                after?.[0] ?? null,
                after?.[1] ?? null,
                after?.[2] ?? null,
              ],
        )
      ).rows;
      await lockReferencePlan(tx, [
        ...new Set([
          incoming ? selection.target.resource_id : selection.source,
          ...candidates.slice(0, 100).flatMap((row) => [row.source_id, row.target_id]),
        ]),
      ]);
      let selectedTarget: ResolvedTargetView | undefined;
      if (incoming) selectedTarget = await this.resolve(tx, actor, selection.target);
      else {
        await lockContext(tx, selection.source, 'resolution', [
          'contribution',
          'artifact',
          'summary',
        ]);
        await requireRevision(tx, selection.source, selection.revision);
      }
      const page: ReferencePageView = {
        items: [],
        direction: incoming ? 'incoming' : 'outgoing',
        scope: incoming
          ? selection.target.file_id
            ? 'file'
            : selection.target.revision_id
              ? 'revision'
              : 'resource'
          : 'source_revision',
        ...(incoming
          ? { target: selection.target }
          : { source_id: selection.source, source_revision_id: selection.revision }),
        history: incoming ? selection.history : 'selected_revision',
        relationship: incoming ? selection.relationship : null,
        order: 'source_revision_uuid_then_field_then_reference_uuid',
        omitted_detail: 'bodies; unrelated_target_scopes',
        next_cursor: null,
        complete: false,
        work_budget_reached: false,
        limit,
        max_response_bytes: budget,
        expires_at: new Date(expires).toISOString(),
      };
      let consumed = 0,
        last = after;
      for (const row of candidates.slice(0, 100)) {
        let entry: ReferenceEntryView | undefined;
        try {
          const current =
            incoming && selection.history === 'current'
              ? (
                  await tx.query<{ current_revision_id: string | null }>(
                    'SELECT current_revision_id FROM loom.resources WHERE id=$1',
                    [row.source_id],
                  )
                ).rows[0]?.current_revision_id
              : row.revision_id;
          if (
            current === row.revision_id &&
            (!incoming ||
              selection.relationship === null ||
              (row.relationship ?? 'untyped') === selection.relationship)
          )
            entry = await this.entry(tx, actor, row, selectedTarget);
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        }
        if (entry) {
          const next = [row.revision_id, row.source_field, row.reference_id] as [
            string,
            string,
            string,
          ];
          const preview = {
            ...page,
            items: [...page.items, entry],
            next_cursor: this.encode({ binding, boundary: state, after: next, expires }),
          };
          if (page.items.length === limit || Buffer.byteLength(JSON.stringify(preview)) > budget) {
            if (!page.items.length) fit(preview, budget);
            break;
          }
          page.items.push(entry);
        }
        last = [row.revision_id, row.source_field, row.reference_id];
        consumed++;
      }
      page.complete = consumed === candidates.length;
      page.work_budget_reached = !page.complete && consumed === referenceLimits.scan;
      if (!page.complete)
        page.next_cursor = this.encode({ binding, boundary: state, after: last, expires });
      return fit(page, budget);
    });
  }
  private async entry(
    tx: SqlTransaction,
    actor: Awaited<ReturnType<typeof lockActor>>,
    row: ReferenceRow,
    selectedTarget?: ResolvedTargetView,
  ): Promise<ReferenceEntryView> {
    const source = await this.reads.resource(tx, actor, row.source_id, row.revision_id);
    const current = (await lockContext(tx, row.source_id, 'resolution'))[0]!.current_revision_id;
    const available =
      current &&
      (
        await tx.query(
          "SELECT id FROM loom.revisions WHERE id=$1 AND availability='available' FOR SHARE",
          [current],
        )
      ).rowCount;
    let membership: ReferenceEntryView['membership'] = 'current_unavailable';
    if (available) {
      if (current === row.revision_id) membership = 'current';
      else if (row.source_field === 'change_note') membership = 'historical_note';
      else {
        const now = (
          await tx.query<ReferenceRow>(
            "SELECT * FROM loom.revision_references WHERE revision_id=$1 AND source_field='main' AND reference_id=$2",
            [current, row.reference_id],
          )
        ).rows[0];
        membership = !now
          ? 'withdrawn'
          : now.assertion_revision_id === row.assertion_revision_id
            ? 'carried_forward'
            : 'changed';
      }
    }
    const attribution = async (revision: string) => {
      const value = (
        await tx.query<{
          id: string;
          nickname: string;
          kind: string;
          created_at: Date;
          availability: string;
        }>(
          `SELECT p.id,p.nickname,p.kind,v.created_at,v.availability
        FROM loom.revisions v JOIN loom.participants p ON p.id=v.publisher_id WHERE v.id=$1 AND v.resource_id=$2`,
          [revision, row.source_id],
        )
      ).rows[0]!;
      return {
        participant: { id: value.id, nickname: value.nickname, kind: value.kind },
        published_at: value.created_at.toISOString(),
        revision_id: value.availability === 'available' ? revision : null,
      };
    };
    let target: ReferenceEntryView['target'] = selectedTarget ?? { state: 'unavailable' };
    if (!selectedTarget)
      try {
        target = await this.resolve(tx, actor, declaration(row).target);
      } catch (error) {
        if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
      }
    const withdrawn =
      membership === 'withdrawn'
        ? (
            await tx.query<{ revision_id: string }>(
              `SELECT w.revision_id
      FROM loom.reference_withdrawals w JOIN loom.revisions v ON v.id=w.revision_id
      WHERE w.source_id=$1 AND w.reference_id=$2
      ORDER BY w.revision_number DESC LIMIT 1`,
              [row.source_id, row.reference_id],
            )
          ).rows[0]
        : undefined;
    const withdrawal = withdrawn ? await attribution(withdrawn.revision_id) : null;
    return {
      declaration: declaration(row),
      source_field: row.source_field,
      direction: 'source_to_target',
      source,
      source_browser_url: `/loom/resource/${row.source_id}/${row.revision_id}`,
      source_context_url: contextUrl(source),
      original_assertion: await attribution(row.origin_revision_id),
      last_assertion_change: await attribution(row.assertion_revision_id),
      withdrawal: withdrawal?.revision_id ? withdrawal : null,
      membership,
      target,
    };
  }
}
