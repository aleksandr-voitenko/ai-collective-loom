import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/notes.js';
import { UUID, type ReferenceTargetValue } from '../../../contracts/participation.js';
import { validUnicode } from '../../../contracts/authored.js';
import type { Transactions, SqlTransaction } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { lockActor } from '../publication/guards.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { fit, RetrievalError } from '../participation/retrieval.js';
import { lockReferencePlan, referenceTarget } from '../participation/reference-context.js';

export class NoteError extends Error {
  constructor(readonly code: 'note_limit' | 'note_deleted' | 'note_collection_changed') {
    super(
      {
        note_limit:
          'The synthetic private note limit is reached. Current reads, exact recovery and deletion of admitted notes remain available.',
        note_deleted:
          'This note identity is deleted. It cannot be reused. Earlier operation outcomes may still need reconciliation.',
        note_collection_changed: 'Your notes changed. Start a new traversal to continue.',
      }[code],
    );
  }
}
type Row = {
  participant_id: string;
  id: string;
  version: number;
  title: string | null;
  body: string | null;
  links: ReferenceTargetValue[] | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};
type Decision = {
  id: string;
  action: C.NoteActionValue;
  request_digest: string;
  note_id: string;
  expected_version: number;
  result_version: number;
  decision: 'applied' | 'version_conflict';
  decided_at: Date;
};
type Owner = { version: number; identities: number; active: number; decisions: number };
function identity(row: Row): C.NoteIdentityView {
  return {
    note_id: row.id,
    version: row.version,
    state: row.deleted_at ? 'deleted' : 'active',
    deleted_at: row.deleted_at?.toISOString() ?? null,
  };
}
function detail(row: Row): C.NoteDetailView {
  return row.deleted_at
    ? {
        note_id: row.id,
        version: row.version,
        state: 'deleted',
        deleted_at: row.deleted_at.toISOString(),
      }
    : {
        note_id: row.id,
        version: row.version,
        state: 'active',
        title: row.title!,
        body: row.body!,
        links: row.links!,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      };
}
export function normalizeNoteLinks(links: ReferenceTargetValue[]) {
  const normalized = links
    .map((link) => ({
      kind: link.kind,
      resource_id: link.resource_id.toLowerCase(),
      ...(link.revision_id ? { revision_id: link.revision_id.toLowerCase() } : {}),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (
    normalized.some(
      (link, i) =>
        (link.kind === 'discussion' && link.revision_id) ||
        (i > 0 && JSON.stringify(link) === JSON.stringify(normalized[i - 1])),
    ) ||
    Buffer.byteLength(JSON.stringify(normalized)) > C.noteLimits.linkBytes
  )
    throw new PublicationError('invalid_input');
  return normalized;
}
export class PrivateNotes {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly database: Transactions) {}
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
      if (error instanceof NoteError || error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
  private async owner(tx: SqlTransaction, context: ActorContext, write: boolean) {
    const actor = await lockActor(tx, context);
    await tx.query(
      `SELECT ${write ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`,
      [JSON.stringify(['loom.notes.owner', actor.participantId])],
    );
    await lockActor(tx, context);
    return actor.participantId;
  }
  private async find(tx: SqlTransaction, owner: string, id: string) {
    return (
      await tx.query<Row>('SELECT * FROM loom.private_notes WHERE participant_id=$1 AND id=$2', [
        owner,
        id,
      ])
    ).rows[0];
  }
  private async required(tx: SqlTransaction, owner: string, id: string) {
    const row = await this.find(tx, owner, id);
    if (!row) throw new PublicationError('unavailable');
    return row;
  }
  private async decision(
    tx: SqlTransaction,
    owner: string,
    action: C.NoteActionValue,
    key: string,
  ) {
    return (
      await tx.query<Decision>(
        'SELECT * FROM loom.note_operations WHERE participant_id=$1 AND action=$2 AND idempotency_key=$3',
        [owner, action, key],
      )
    ).rows[0];
  }
  private async result(
    tx: SqlTransaction,
    owner: string,
    saved: Decision,
    replayed: boolean,
  ): Promise<C.NoteResultView> {
    const row = await this.required(tx, owner, saved.note_id);
    return {
      operation_state: saved.decision,
      operation_id: saved.id,
      action: saved.action,
      idempotency: replayed ? 'replayed' : 'created',
      outcome: {
        note_id: saved.note_id,
        expected_version: saved.expected_version,
        result_version: saved.result_version,
        decided_at: saved.decided_at.toISOString(),
      },
      current: identity(row),
    };
  }
  change(
    context: ActorContext,
    action: C.NoteActionValue,
    value: unknown,
  ): Promise<C.NoteResultView> {
    if (!Value.Check(C.noteCommands[action], value)) throw new PublicationError('invalid_input');
    const input = value as C.NoteUpdateInput,
      key = input.idempotency_key.toLowerCase(),
      id = input.note_id.toLowerCase(),
      expected = action === 'create' ? 0 : input.expected_version;
    let links: ReferenceTargetValue[] = [];
    if (action !== 'delete') {
      for (const [text, limit] of [
        [input.title, C.noteLimits.titleBytes],
        [input.body, C.noteLimits.bodyBytes],
      ] as const)
        if (!validUnicode(text) || text.includes('\0') || Buffer.byteLength(text) > limit)
          throw new PublicationError('invalid_input');
      if (!input.body.trim()) throw new PublicationError('invalid_input');
      links = normalizeNoteLinks(input.links);
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          C.noteContract,
          action,
          id,
          expected,
          ...(action === 'delete' ? [] : [input.title, input.body, links]),
        ]),
      )
      .digest('hex');
    return this.run(async (tx) => {
      await lockAttempt(tx, identityOf(context).participantId, 'notes.' + action, key);
      const owner = await this.owner(tx, context, true),
        saved = await this.decision(tx, owner, action, key);
      if (saved) {
        if (saved.request_digest !== digest) throw new PublicationError('idempotency_conflict');
        return this.result(tx, owner, saved, true);
      }
      let row = await this.find(tx, owner, id);
      if (!row && action !== 'create') throw new PublicationError('unavailable');
      if (row?.deleted_at) throw new NoteError('note_deleted');
      const decision = (row?.version ?? 0) === expected ? 'applied' : 'version_conflict';
      const state = (
        await tx.query<Owner>('SELECT * FROM loom.note_owners WHERE participant_id=$1', [owner])
      ).rows[0] ?? { version: 0, identities: 0, active: 0, decisions: 0 };
      const terminal = action === 'delete' && decision === 'applied';
      if (
        (!terminal && state.decisions >= C.noteLimits.decisions) ||
        (!row &&
          (state.identities >= C.noteLimits.identities || state.active >= C.noteLimits.active))
      )
        throw new NoteError('note_limit');
      if (decision === 'applied' && action !== 'delete') {
        const retained = new Set((row?.links ?? []).map((link) => JSON.stringify(link))),
          introduced = links.filter((link) => !retained.has(JSON.stringify(link)));
        if (introduced.length) {
          await lockReferencePlan(
            tx,
            introduced.map((link) => link.resource_id),
          );
          for (const link of introduced) await referenceTarget(tx, link);
        }
      }
      // Authorization is held through COMMIT, with expiry rechecked after source waits.
      await lockActor(tx, context);
      await tx.query(
        'INSERT INTO loom.note_owners(participant_id) VALUES($1) ON CONFLICT DO NOTHING',
        [owner],
      );
      if (decision === 'applied') {
        if (!row) {
          row = (
            await tx.query<Row>(
              'INSERT INTO loom.private_notes(participant_id,id,version,title,body,links) VALUES($1,$2,1,$3,$4,$5::jsonb) RETURNING *',
              [owner, id, input.title, input.body, JSON.stringify(links)],
            )
          ).rows[0]!;
        } else {
          row = (
            await tx.query<Row>(
              `UPDATE loom.private_notes SET version=version+1,updated_at=clock_timestamp(),
            title=$3,body=$4,links=$5::jsonb,deleted_at=CASE WHEN $6 THEN clock_timestamp() ELSE NULL END
            WHERE participant_id=$1 AND id=$2 RETURNING *`,
              [
                owner,
                id,
                terminal ? null : input.title,
                terminal ? null : input.body,
                terminal ? null : JSON.stringify(links),
                terminal,
              ],
            )
          ).rows[0]!;
        }
      }
      await tx.query(
        'UPDATE loom.note_owners SET version=version+$2,identities=identities+$3,active=active+$4,decisions=decisions+$5 WHERE participant_id=$1',
        [
          owner,
          decision === 'applied' ? 1 : 0,
          action === 'create' && decision === 'applied' ? 1 : 0,
          terminal ? -1 : action === 'create' && decision === 'applied' ? 1 : 0,
          terminal ? 0 : 1,
        ],
      );
      const outcome = (
        await tx.query<Decision>(
          `INSERT INTO loom.note_operations(id,participant_id,action,idempotency_key,note_id,semantic_version,request_digest,expected_version,result_version,decision)
        VALUES($1,$2,$3,$4,$5,'owner-notes-1',$6,$7,$8,$9) RETURNING *`,
          [randomUUID(), owner, action, key, id, digest, expected, row!.version, decision],
        )
      ).rows[0]!;
      return this.result(tx, owner, outcome, false);
    });
  }
  status(context: ActorContext, value: unknown): Promise<C.NoteStatusView> {
    if (!Value.Check(C.NoteStatusInput, value)) throw new PublicationError('invalid_input');
    return this.run(async (tx) => {
      const key = value.idempotency_key.toLowerCase();
      await lockAttempt(tx, identityOf(context).participantId, 'notes.' + value.action, key);
      const owner = await this.owner(tx, context, false),
        saved = await this.decision(tx, owner, value.action as C.NoteActionValue, key);
      return saved ? this.result(tx, owner, saved, true) : { operation_state: 'not_recorded' };
    });
  }
  read(context: ActorContext, id: string): Promise<C.NoteDetailView> {
    if (!Value.Check(UUID, id)) throw new PublicationError('invalid_input');
    return this.run(async (tx) => {
      const owner = await this.owner(tx, context, false),
        row = await this.required(tx, owner, id.toLowerCase());
      return fit(detail(row), C.noteLimits.detailBytes);
    });
  }
  sources(context: ActorContext, id: string): Promise<C.NoteSourcesView> {
    if (!Value.Check(UUID, id)) throw new PublicationError('invalid_input');
    return this.run(async (tx) => {
      const owner = await this.owner(tx, context, false),
        row = await this.required(tx, owner, id.toLowerCase()),
        items: C.NoteSourcesView['items'] = [];
      const links = row.links ?? [];
      if (links.length)
        await lockReferencePlan(
          tx,
          links.map((link) => link.resource_id),
        );
      for (const target of links) {
        let source: C.NoteSourcesView['items'][number]['source'] = { state: 'unavailable' };
        try {
          const resolved = await referenceTarget(tx, target);
          const title = (
            await tx.query<{ title: string | null }>(
              'SELECT title FROM loom.revisions WHERE id=$1',
              [resolved.revision],
            )
          ).rows[0]!.title;
          source = {
            state: 'available',
            title,
            url:
              target.kind === 'discussion'
                ? '/loom/discussion/' + target.resource_id
                : '/loom/resource/' +
                  target.resource_id +
                  (target.revision_id ? '/' + target.revision_id : ''),
          };
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        }
        items.push({ target, source });
      }
      await lockActor(tx, context);
      return fit({ note_id: row.id, version: row.version, items }, C.noteLimits.pageBytes);
    });
  }
  private encode(owner: string, query: string, version: number, after: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.cursorKey, nonce);
    const data = Buffer.concat([
      cipher.update(
        JSON.stringify({
          owner,
          query,
          version,
          after,
          expires: Date.now() + 300000,
          ordering: 'note_id_ascending',
        }),
      ),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
  }
  private decode(owner: string, query: string, token: string) {
    try {
      const bytes = Buffer.from(token, 'base64url'),
        cipher = createDecipheriv('aes-256-gcm', this.cursorKey, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const value = JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
      ) as {
        owner: string;
        query: string;
        version: number;
        after: string;
        expires: number;
        ordering: string;
      };
      if (
        value.owner !== owner ||
        value.query !== query ||
        value.ordering !== 'note_id_ascending' ||
        !Number.isInteger(value.version) ||
        !Value.Check(UUID, value.after) ||
        !Number.isFinite(value.expires) ||
        value.expires < Date.now()
      )
        throw new Error();
      return value;
    } catch {
      throw new RetrievalError('invalid_cursor');
    }
  }
  list(context: ActorContext, value: unknown): Promise<C.NotePageView> {
    if (!Value.Check(C.NoteQuery, value)) throw new PublicationError('invalid_input');
    const query = value.query.trim().replace(/\s+/gu, ' '),
      size = value.limit ?? 12,
      budget = value.max_response_bytes ?? C.noteLimits.pageBytes;
    if (
      !validUnicode(query) ||
      query.includes('\0') ||
      Buffer.byteLength(query) > C.noteLimits.queryBytes ||
      (query && query.split(' ').length > C.noteLimits.queryTerms)
    )
      throw new PublicationError('invalid_input');
    return this.run(async (tx) => {
      const owner = await this.owner(tx, context, false),
        cursor = value.cursor ? this.decode(owner, query, value.cursor) : undefined;
      const version =
        (
          await tx.query<{ version: number }>(
            'SELECT version FROM loom.note_owners WHERE participant_id=$1',
            [owner],
          )
        ).rows[0]?.version ?? 0;
      if (cursor && cursor.version !== version) throw new NoteError('note_collection_changed');
      const rows = (
        await tx.query<Row>(
          `SELECT id,version,title,left(body,161) AS body,links,updated_at FROM loom.private_notes
        WHERE participant_id=$1 AND deleted_at IS NULL AND ($2='' OR lexical @@ plainto_tsquery('simple',$2))
        AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
          [owner, query, cursor?.after ?? null, size + 1],
        )
      ).rows;
      const page: C.NotePageView = {
        items: [],
        next_cursor: null,
        complete: false,
        collection_version: version,
        scope: 'own_current_notes',
        ordering: 'note_id_ascending',
        matching: 'simple_lexical_and',
        limit: size,
        max_response_bytes: budget,
      };
      for (const row of rows.slice(0, size)) {
        const chars = Array.from(row.body!),
          item = {
            note_id: row.id,
            version: row.version,
            title: row.title!,
            excerpt: chars.slice(0, 160).join(''),
            excerpt_abbreviated: chars.length > 160,
            links: row.links!,
            updated_at: row.updated_at.toISOString(),
          };
        const next = this.encode(owner, query, version, row.id);
        if (
          Buffer.byteLength(
            JSON.stringify({ ...page, items: [...page.items, item], next_cursor: next }),
          ) > budget
        ) {
          if (!page.items.length) throw new RetrievalError('response_budget_too_small');
          break;
        }
        page.items.push(item);
      }
      page.complete = page.items.length === rows.length;
      if (!page.complete)
        page.next_cursor = this.encode(owner, query, version, page.items.at(-1)!.note_id);
      return fit(page, budget);
    });
  }
}
