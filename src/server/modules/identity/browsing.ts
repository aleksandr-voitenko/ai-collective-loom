import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { input } from './contracts.js';
import { requireAdministrator } from './policy.js';
import { IdentityError, identityFailure } from './errors.js';
import {
  administrationContract,
  administrationLimits as limits,
  AdministrationPageInput,
  CredentialPageInput,
  AccountLookupInput,
  type AdministrationPageView,
  type AdministrativeAccountView,
  type AdministrativeCredentialView,
  type IdentityAuditRecordView,
} from '../../../contracts/administration.js';

type Collection = 'accounts' | 'credentials' | 'audit';
interface Position {
  id: string;
  recorded_at?: string;
}
interface Cursor {
  owner: string;
  collection: Collection;
  target: string | null;
  version: string;
  after: Position;
  expires: number;
  contract: typeof administrationContract;
}
const fields = {
  accounts: 'id,nickname,kind,role,state',
  credentials: 'id,kind,label,state,expires_at,created_at,parent_credential_id',
  // Preserve PostgreSQL microseconds for the key, rather than rounding through Date.
  audit: `id,actor_id,actor_credential_id,authority,target_id,action,operation_id,to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at`,
};

/** Finite process key only: no per-traversal directory, transaction or cursor cache. */
export class AdministrationBrowsing {
  private readonly key = randomBytes(32);
  private readonly instance = randomBytes(8).toString('hex');
  constructor(private readonly database: Transactions) {}

  private seal(cursor: Cursor) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(administrationContract));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(cursor), 'utf8'), cipher.final()]);
    return (
      this.instance + '.' + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url')
    );
  }
  private open(
    token: string,
    owner: string,
    collection: Collection,
    target: string | null,
  ): Cursor {
    if (!/^[a-f0-9]{16}\.[A-Za-z0-9_-]+$/.test(token)) throw new IdentityError('invalid_cursor');
    if (token.slice(0, 16) !== this.instance) throw new IdentityError('cursor_restart');
    let cursor: Cursor;
    try {
      const bytes = Buffer.from(token.slice(17), 'base64url');
      if (bytes.toString('base64url') !== token.slice(17)) throw new Error('Invalid encoding');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(administrationContract));
      decipher.setAuthTag(bytes.subarray(12, 28));
      cursor = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      ) as Cursor;
    } catch {
      throw new IdentityError('invalid_cursor');
    }
    if (
      cursor.owner !== owner ||
      cursor.collection !== collection ||
      cursor.target !== target ||
      cursor.contract !== administrationContract
    )
      throw new IdentityError('invalid_cursor');
    if (cursor.expires <= Date.now()) throw new IdentityError('cursor_expired');
    return cursor;
  }
  private async read<T>(actor: ActorContext, operation: (tx: SqlTransaction) => Promise<T>) {
    try {
      return await this.database.transaction(async (tx) => {
        // One fresh snapshot per page, with actual current-authority row guards.
        // A withdrawal committed before a guard is acquired forces retry/refusal.
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
        await tx.query("SET LOCAL statement_timeout = '1000ms'", []);
        await tx.query("SET LOCAL lock_timeout = '1000ms'", []);
        await requireAdministrator(tx, actor);
        return operation(tx);
      });
    } catch (error) {
      // The tighter query deadline belongs only to bounded administrative reads.
      if (error && typeof error === 'object' && 'code' in error && error.code === '57014')
        throw new IdentityError('retryable');
      throw identityFailure(error);
    }
  }
  async lookup(actor: ActorContext, value: unknown): Promise<AdministrativeAccountView> {
    const query = input(AccountLookupInput, value);
    return this.read(actor, async (tx) => {
      const row = (
        await tx.query<{ item: AdministrativeAccountView | null }>(
          `SELECT CASE WHEN octet_length(row_to_json(candidate)::text) <= $2 THEN row_to_json(candidate) ELSE NULL END AS item FROM (SELECT ${fields.accounts} FROM loom.participants WHERE kind <> 'internal' AND ${'id' in query ? 'id = $1' : 'lower(nickname) = $1'} LIMIT 1) candidate`,
          ['id' in query ? query.id.toLowerCase() : query.nickname.toLowerCase(), limits.bytes],
        )
      ).rows[0];
      if (!row) throw new IdentityError('unavailable');
      if (!row.item || Buffer.byteLength(JSON.stringify(row.item), 'utf8') > limits.bytes)
        throw new IdentityError('page_budget_exceeded');
      return row.item;
    });
  }
  accounts(actor: ActorContext, value: unknown) {
    return this.page<AdministrativeAccountView>(actor, 'accounts', value);
  }
  credentials(actor: ActorContext, value: unknown) {
    return this.page<AdministrativeCredentialView>(actor, 'credentials', value);
  }
  audit(actor: ActorContext, value: unknown) {
    return this.page<IdentityAuditRecordView>(actor, 'audit', value);
  }
  private async page<T extends QueryResultRow & Position>(
    actor: ActorContext,
    collection: Collection,
    value: unknown,
  ): Promise<AdministrationPageView<T>> {
    const query = input(
      collection === 'credentials' ? CredentialPageInput : AdministrationPageInput,
      value,
    );
    const target = 'participant_id' in query ? String(query.participant_id).toLowerCase() : null;
    const limit = query.limit ?? limits.items,
      maxBytes = query.max_bytes ?? limits.bytes;
    return this.read(actor, async (tx) => {
      // Authorization precedes token/target inspection, including foreign cursors.
      const cursor = query.cursor
        ? this.open(query.cursor, identityOf(actor).participantId, collection, target)
        : undefined;
      const version = (
        await tx.query<{ version: string }>(
          'SELECT version::text FROM loom.administration_collections WHERE collection = $1',
          [collection],
        )
      ).rows[0]!.version;
      if (cursor && cursor.version !== version) throw new IdentityError('collection_changed');
      if (
        target &&
        !(
          await tx.query("SELECT id FROM loom.participants WHERE id = $1 AND kind <> 'internal'", [
            target,
          ])
        ).rowCount
      )
        throw new IdentityError('unavailable');
      const expires = cursor?.expires ?? Date.now() + limits.seconds * 1000;
      const after = cursor?.after;
      const parameters: unknown[] = [];
      const bind = (v: unknown) => {
        parameters.push(v);
        return '$' + parameters.length;
      };
      const where =
        collection === 'accounts'
          ? ["kind <> 'internal'"]
          : collection === 'credentials'
            ? ['participant_id = ' + bind(target)]
            : [];
      if (after)
        where.push(
          collection === 'audit'
            ? `(recorded_at,id) > (${bind(after.recorded_at)}::timestamptz,${bind(after.id)}::uuid)`
            : 'id > ' + bind(after.id) + '::uuid',
        );
      const table =
        collection === 'accounts'
          ? 'participants'
          : collection === 'credentials'
            ? 'participant_credentials'
            : 'administrative_audit';
      const order = collection === 'audit' ? 'recorded_at,id' : 'id';
      // At most limit+1 indexed candidates. Oversized database text never enters
      // the process; a sentinel stops at that exact item without skipping it.
      const rows = (
        await tx.query<{ item: T | null }>(
          `SELECT CASE WHEN octet_length(row_to_json(candidate)::text) <= ${bind(maxBytes)} THEN row_to_json(candidate) ELSE NULL END AS item FROM (SELECT ${fields[collection]} FROM loom.${table} AS source${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${collection === 'audit' ? 'source.recorded_at,source.id' : 'source.id'} LIMIT ${bind(limit + 1)}) candidate`,
          parameters,
        )
      ).rows;
      const items: T[] = [];
      const result = (
        complete: boolean,
        position: Position | undefined,
      ): AdministrationPageView<T> => ({
        contract: administrationContract,
        scope: { collection, participant_id: target, order, consistency: 'restart-on-change' },
        items: [...items],
        next_cursor: complete
          ? null
          : this.seal({
              owner: identityOf(actor).participantId,
              collection,
              target,
              version,
              // Position typing does not strip metadata DTO fields at runtime.
              after: {
                id: position!.id,
                ...(collection === 'audit' ? { recorded_at: position!.recorded_at } : {}),
              },
              expires,
              contract: administrationContract,
            }),
        complete,
        expires_at: new Date(expires).toISOString(),
      });
      for (let index = 0; index < Math.min(rows.length, limit); index++) {
        const row = rows[index]!.item;
        if (row) items.push(row);
        const candidate = row ? result(index === rows.length - 1, row) : undefined;
        if (!candidate || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) {
          if (row) items.pop();
          if (!items.length) throw new IdentityError('page_budget_exceeded');
          return result(false, items.at(-1));
        }
      }
      const page = result(rows.length <= limit, items.at(-1));
      if (Buffer.byteLength(JSON.stringify(page), 'utf8') > maxBytes)
        throw new IdentityError('page_budget_exceeded');
      return page;
    });
  }
}
