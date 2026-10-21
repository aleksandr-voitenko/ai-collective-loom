import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { ActorContext } from '../publication/actor.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { safeError, PublicationError } from '../publication/errors.js';
import { ParticipationRetrieval, RetrievalError, responseBudget, fit } from './retrieval.js';
import { lockReferencePlan } from './reference-context.js';
import { structureGuard } from './organization-context.js';
import {
  SummaryPageInput,
  MaintenanceInput,
  summaryLimits,
  type SummaryPageOptions,
  type MaintenanceOptions,
  type CoverageView,
  type SourcePageView,
  type SourceEntryView,
  type MaintenancePageView,
  type SummaryLookupView,
  type MaintenanceEntryView,
} from '../../../contracts/summaries.js';
import {
  SummaryError,
  summaryBoundary,
  coverageSet,
  currentSources,
  eligibleSource,
  availableMember,
  preparation,
  preparedMembers,
  type Member,
  type SourceRow,
} from './summary-context.js';
import { preparationView } from './summary-preparation.js';
import type { PreparedCoverage } from '../publication/summary-storage.js';

type Cursor = { binding: string; boundary: string; after: string | null; expires: number };
type Actor = Awaited<ReturnType<typeof lockActor>>;
export class DiscussionSummaries {
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
      if (Buffer.byteLength(value) > summaryLimits.cursorBytes) throw new Error();
      const bytes = Buffer.from(value, 'base64url'),
        decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const data = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      ) as Cursor;
      if (
        !Number.isFinite(data.expires) ||
        data.expires <= Date.now() ||
        !data.after ||
        !/^[0-9a-f-]{36}$/.test(data.after)
      )
        throw new Error();
      return data;
    } catch {
      throw new SummaryError('summary_changed');
    }
  }
  private async run<T>(work: (tx: SqlTransaction) => Promise<T>) {
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
        await tx.query("SET LOCAL statement_timeout='2500ms'", []);
        return work(tx);
      });
    } catch (error) {
      if (error instanceof SummaryError || error instanceof RetrievalError) throw error;
      if (['40001', '40P01', '55P03'].includes(String((error as { code?: string })?.code)))
        throw new SummaryError('summary_changed');
      if ((error as { code?: string })?.code === '57014')
        throw new SummaryError('summary_source_limit');
      return safeError(error);
    }
  }
  private async continuation(
    tx: SqlTransaction,
    actor: Actor,
    selection: unknown,
    options: SummaryPageOptions,
  ) {
    const boundary = await summaryBoundary(tx),
      binding = JSON.stringify([actor.participantId, selection]);
    const saved = options.cursor ? this.decode(options.cursor) : undefined;
    if (saved && (saved.binding !== binding || saved.boundary !== boundary))
      throw new SummaryError('summary_changed');
    return {
      binding,
      boundary,
      after: saved?.after ?? null,
      expires: saved?.expires ?? Date.now() + summaryLimits.cursorSeconds * 1000,
    };
  }
  lookup(actorContext: ActorContext, discussion: string): Promise<SummaryLookupView> {
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext);
      const row = (
        await tx.query<{ id: string }>('SELECT id FROM loom.summaries WHERE discussion_id=$1', [
          discussion,
        ])
      ).rows[0];
      await lockReferencePlan(tx, [discussion, ...(row ? [row.id] : [])]);
      const chain = await lockContext(tx, discussion, 'resolution', ['discussion']);
      if (!row) return { state: 'absent', can_create: chain.every((r) => r.publication_open) };
      try {
        return { state: 'available', summary: await this.reads.resource(tx, actor, row.id) };
      } catch (error) {
        if (error instanceof PublicationError && error.code === 'unavailable')
          return { state: 'unavailable' };
        throw error;
      }
    });
  }
  prepared(actorContext: ActorContext, id: string) {
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext),
        row = await preparation(tx, actor.participantId, id),
        members = await preparedMembers(tx, id);
      await lockReferencePlan(tx, [row.discussion_id, ...members.map((m) => m.contribution_id)]);
      await lockContext(tx, row.discussion_id, 'resolution', ['discussion']);
      await preparation(tx, actor.participantId, id);
      return preparationView(tx, row, members);
    });
  }
  private async compare(
    tx: SqlTransaction,
    set: PreparedCoverage,
    current: SourceRow[],
  ): Promise<CoverageView> {
    const base = {
      scope: set.scope,
      claim: 'author_declared; not_read_or_correctness_proof' as const,
    };
    if (current.length > summaryLimits.sources)
      return {
        ...base,
        uncovered_eligible: null,
        changed_eligible: null,
        unknown: true,
        comparison: 'work_limited',
      };
    let uncovered = 0,
      changed = 0,
      unknown = false;
    const available = new Set<string>();
    for (const member of set.members) {
      if (await availableMember(tx, set.discussion_id, member))
        available.add(member.contribution_id);
      else unknown = true;
    }
    for (const row of current) {
      if (!eligibleSource(row) || !(await availableMember(tx, set.discussion_id, row))) {
        unknown = true;
        continue;
      }
      const prior = set.members.find((m) => m.contribution_id === row.contribution_id);
      if (!prior) uncovered++;
      else if (
        available.has(prior.contribution_id) &&
        prior.source_revision_id !== row.source_revision_id
      )
        changed++;
    }
    return {
      ...base,
      uncovered_eligible: uncovered,
      changed_eligible: changed,
      unknown,
      comparison: 'complete',
    };
  }
  coverage(actorContext: ActorContext, summary: string, revision: string) {
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext),
        set = await coverageSet(tx, revision);
      if (set.summary_id !== summary) throw new PublicationError('unavailable');
      await structureGuard(tx);
      const current = await currentSources(tx, set.discussion_id);
      await lockReferencePlan(tx, [
        summary,
        ...set.members.map((m) => m.contribution_id),
        ...current.map((m) => m.contribution_id),
      ]);
      await lockContext(tx, summary, 'resolution', ['summary']);
      await requireRevision(tx, summary, revision);
      void actor;
      return {
        summary_id: summary,
        revision_id: revision,
        discussion_id: set.discussion_id,
        coverage: await this.compare(tx, set, current),
        members_url: `/api/v1/summaries/${summary}/revisions/${revision}/members`,
        sources_url: `/api/v1/summaries/${summary}/revisions/${revision}/sources`,
      };
    });
  }
  members(
    actor: ActorContext,
    selection: { preparation: string } | { summary: string; revision: string },
    options: SummaryPageOptions,
  ) {
    return this.sourcesPage(actor, selection, options);
  }
  sources(
    actor: ActorContext,
    selection: { discussion: string } | { summary: string; revision: string; current: true },
    options: SummaryPageOptions,
  ) {
    return this.sourcesPage(actor, selection, options);
  }
  private sourcesPage(
    actorContext: ActorContext,
    selection:
      | { preparation: string }
      | { summary: string; revision: string; current?: true }
      | { discussion: string },
    options: SummaryPageOptions,
  ) {
    if (!Value.Check(SummaryPageInput, options)) throw new PublicationError('invalid_input');
    const budget = responseBudget(options.max_response_bytes),
      limit = Number(options.limit ?? 12);
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext),
        cursor = await this.continuation(tx, actor, selection, options);
      await structureGuard(tx);
      let discussion: string,
        members: Member[] = [],
        current = false,
        summary: string | undefined;
      if ('preparation' in selection) {
        const row = await preparation(tx, actor.participantId, selection.preparation);
        discussion = row.discussion_id;
        members = await preparedMembers(tx, row.id);
      } else if ('summary' in selection) {
        const set = await coverageSet(tx, selection.revision);
        if (set.summary_id !== selection.summary) throw new PublicationError('unavailable');
        discussion = set.discussion_id;
        members = [...set.members];
        current = !!selection.current;
        summary = selection.summary;
      } else {
        discussion = selection.discussion;
        current = true;
      }
      const candidates: Member[] = current
        ? (
            await tx.query<Member>(
              `SELECT c.id AS contribution_id,r.current_revision_id AS source_revision_id
        FROM loom.contributions c JOIN loom.resources r ON r.id=c.id WHERE c.discussion_id=$1 AND ($2::uuid IS NULL OR c.id>$2)
        ORDER BY c.id LIMIT 101`,
              [discussion, cursor.after],
            )
          ).rows
        : members.filter((m) => !cursor.after || m.contribution_id > cursor.after);
      await lockReferencePlan(tx, [
        discussion,
        ...(summary ? [summary] : []),
        ...members.map((m) => m.contribution_id),
        ...candidates.slice(0, 100).map((m) => m.contribution_id),
      ]);
      await lockContext(tx, discussion, 'resolution', ['discussion']);
      if ('summary' in selection) {
        await lockContext(tx, selection.summary, 'resolution', ['summary']);
        await requireRevision(tx, selection.summary, selection.revision);
      }
      if ('preparation' in selection)
        await preparation(tx, actor.participantId, selection.preparation);
      const page: SourcePageView = {
        items: [],
        unknown: false,
        next_cursor: null,
        complete: false,
        work_budget_reached: false,
        limit,
        max_response_bytes: budget,
        omitted_detail: 'bodies; unavailable_members',
        expires_at: new Date(cursor.expires).toISOString(),
      };
      let consumed = 0,
        last = cursor.after;
      for (const member of candidates.slice(0, 100)) {
        let entry: SourceEntryView | undefined;
        if (!member.source_revision_id || !(await availableMember(tx, discussion, member)))
          page.unknown = true;
        else {
          const prior = members.find((m) => m.contribution_id === member.contribution_id);
          const priorAvailable = prior ? await availableMember(tx, discussion, prior) : false;
          if (prior && !priorAvailable) page.unknown = true;
          // Do not disclose a suppressed historical member through current-source
          // metadata. Its independent current revision remains readable.
          const source = await this.reads.resource(
            tx,
            actor,
            member.contribution_id,
            member.source_revision_id,
          );
          entry = {
            source,
            ...(priorAvailable ? { declared_revision_id: prior!.source_revision_id } : {}),
            status:
              'preparation' in selection
                ? 'prepared'
                : !current
                  ? 'covered'
                  : prior && !priorAvailable
                    ? 'unknown'
                    : priorAvailable
                      ? prior!.source_revision_id === member.source_revision_id
                        ? 'covered'
                        : 'changed'
                      : 'uncovered',
            context_url: `/loom/discussion/${discussion}?focus=${member.contribution_id}`,
            browser_url: `/loom/resource/${member.contribution_id}/${member.source_revision_id}`,
          };
        }
        if (entry) {
          const preview = {
            ...page,
            items: [...page.items, entry],
            next_cursor: this.encode({ ...cursor, after: member.contribution_id }),
          };
          if (page.items.length === limit || Buffer.byteLength(JSON.stringify(preview)) > budget) {
            if (!page.items.length) fit(preview, budget);
            break;
          }
          page.items.push(entry);
        }
        consumed++;
        last = member.contribution_id;
      }
      page.complete = consumed === candidates.length;
      page.work_budget_reached = !page.complete && consumed === 100;
      if (!page.complete) page.next_cursor = this.encode({ ...cursor, after: last });
      return fit(page, budget);
    });
  }
  maintenance(actorContext: ActorContext, options: MaintenanceOptions) {
    if (
      !Value.Check(MaintenanceInput, options) ||
      (options.descendants !== undefined && !options.topic)
    )
      throw new PublicationError('invalid_input');
    const budget = responseBudget(options.max_response_bytes),
      limit = Number(options.limit ?? 5);
    const selection = {
      filter: options.filter ?? null,
      editable: options.editable ?? null,
      topic: options.topic?.toLowerCase() ?? null,
      descendants: options.descendants === 'true',
    };
    return this.run(async (tx) => {
      const actor = await lockActor(tx, actorContext),
        cursor = await this.continuation(tx, actor, selection, options);
      await structureGuard(tx);
      const rows = (
        await tx.query<{ id: string; discussion_id: string; current_revision_id: string }>(
          `SELECT s.id,s.discussion_id,r.current_revision_id
        FROM loom.summaries s JOIN loom.resources r ON r.id=s.id WHERE ($1::uuid IS NULL OR s.id>$1) ORDER BY s.id LIMIT 11`,
          [cursor.after],
        )
      ).rows;
      const candidates = [];
      for (const row of rows.slice(0, summaryLimits.maintenanceScan))
        candidates.push({
          row,
          set: await coverageSet(tx, row.current_revision_id),
          current: await currentSources(tx, row.discussion_id),
        });
      await lockReferencePlan(tx, [
        ...(selection.topic ? [selection.topic] : []),
        ...candidates.flatMap((c) => [
          c.row.id,
          ...c.set.members.map((m) => m.contribution_id),
          ...c.current.map((m) => m.contribution_id),
        ]),
      ]);
      if (selection.topic) await lockContext(tx, selection.topic, 'resolution', ['area']);
      const page: MaintenancePageView = {
        items: [],
        next_cursor: null,
        complete: false,
        work_budget_reached: false,
        limit,
        max_response_bytes: budget,
        omitted_detail: 'bodies; unavailable_members',
        expires_at: new Date(cursor.expires).toISOString(),
      };
      let consumed = 0,
        last = cursor.after;
      for (const { row, set, current } of candidates) {
        let item: MaintenanceEntryView | undefined;
        try {
          const source = await this.reads.resource(tx, actor, row.id, row.current_revision_id),
            chain = await lockContext(tx, row.id, 'resolution', ['summary']);
          const inScope =
            !selection.topic ||
            (selection.descendants
              ? chain.some((r) => r.id === selection.topic)
              : source.area_id === selection.topic);
          if (
            inScope &&
            (selection.editable === null || source.can_edit === (selection.editable === 'true'))
          ) {
            const editors = (
              await tx.query<{ id: string; nickname: string; kind: string; state: string }>(
                `SELECT p.id,p.nickname,p.kind,p.state FROM loom.resource_editors e
              JOIN loom.participants p ON p.id=e.participant_id WHERE e.resource_id=$1 ORDER BY p.id LIMIT 32`,
                [row.id],
              )
            ).rows;
            const no_active_editor = !editors.some((p) => p.state === 'active'),
              coverage = await this.compare(tx, set, current);
            const matches =
              selection.filter === null ||
              (selection.filter === 'uncovered' && (coverage.uncovered_eligible ?? 0) > 0) ||
              (selection.filter === 'changed' && (coverage.changed_eligible ?? 0) > 0) ||
              (selection.filter === 'partial' && coverage.scope === 'selected') ||
              (selection.filter === 'unknown' && coverage.unknown) ||
              (selection.filter === 'no_active_editor' && no_active_editor);
            if (matches)
              item = {
                summary: source,
                coverage,
                no_active_editor,
                editors: editors.map(({ id, nickname, kind }) => ({ id, nickname, kind })),
                coverage_url: `/api/v1/summaries/${row.id}/revisions/${row.current_revision_id}/coverage`,
                browser_url: `/loom/resource/${row.id}`,
              };
          }
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        }
        if (item) {
          const preview = {
            ...page,
            items: [...page.items, item],
            next_cursor: this.encode({ ...cursor, after: row.id }),
          };
          if (page.items.length === limit || Buffer.byteLength(JSON.stringify(preview)) > budget) {
            if (!page.items.length) fit(preview, budget);
            break;
          }
          page.items.push(item);
        }
        consumed++;
        last = row.id;
      }
      page.complete = consumed === rows.length;
      page.work_budget_reached = !page.complete && consumed === summaryLimits.maintenanceScan;
      if (!page.complete) page.next_cursor = this.encode({ ...cursor, after: last });
      return fit(page, budget);
    });
  }
}
