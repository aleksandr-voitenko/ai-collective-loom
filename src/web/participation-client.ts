import { Value } from "@sinclair/typebox/value";
import { Type, type TSchema } from "@sinclair/typebox";
import type { CommittedView } from "../contracts/participation.js";
import { ReferenceDeclaration, ExactChangeTarget, ReferencedContent, UUID, closed } from "../contracts/participation.js";
import {ApiError,identityGeneration,sessionDiscoveryRevision,establishSession} from './request-context.js';
export {ApiError,identityGeneration,invalidateIdentity,announceIdentityChange} from './request-context.js';
import {classifyResponse,responseContract} from './response-contracts.js';
import {observeRequestFailure,observeSourceDenial} from './authorization-coordinator.js';

// Draft text may be blank or temporarily invalid while being edited. Declaration
// shapes still fail closed on reload; no unknown semantics are silently discarded.
const DraftNote = Type.Union([Type.Null(), Type.Object({...ReferencedContent.properties,text:Type.String()},closed)]);
const DraftAccount = Type.Union([Type.Null(),
  Type.Object({revisions:Type.Array(ExactChangeTarget,{maxItems:16})},closed),
  Type.Object({carry_forward_revision_id:UUID},closed)]);

export interface Self {
  participant_id: string;
  credential_id: string;
  nickname: string;
  kind: string;
  role: string;
  csrf?: string;
}
export interface RequestOptions {
  body?: unknown;
  self?: Self;
  signal?: AbortSignal;
  schema?: TSchema;
}

// These entry points cannot be used as an alternate protected-read transport.
// Keep the exact path and body: saved commands are immutable recovery custody.
export async function sessionRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return independentRequest<T>('session',path,options);
}
export async function commandRequest<T>(path: string, options: RequestOptions & {body: unknown}): Promise<T> {
  if(options.body===undefined)throw new Error('This operation requires the authorization boundary.');
  return independentRequest<T>('receipt',path,options);
}
async function independentRequest<T>(access:'session'|'receipt',path:string,options:RequestOptions):Promise<T>{
  const owner=identityGeneration(),contract=responseContract(path,options.body===undefined?'GET':'POST');
  if(contract.access!==access)throw new Error('This operation requires the authorization boundary.');
  const response=await transportRequest<T>(path,options);
  if(response.observation.denied)observeSourceDenial(owner);
  // A denial consumes content authority, never the private operation result.
  return response.value;
}

// Internal transport. The architecture check permits its import only by the
// authorization boundary; components use its read capability or the APIs above.
export async function transportRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{value:T;contract:ReturnType<typeof responseContract>;observation:ReturnType<typeof classifyResponse>}> {
  const owner = identityGeneration(),discovery=sessionDiscoveryRevision(),contract=responseContract(path,options.body===undefined?'GET':'POST');
  const deadline = AbortSignal.timeout(15000);
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline,
    ...(options.body !== undefined
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options.self?.csrf ? { "x-loom-csrf": options.self.csrf } : {}),
          },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  const value: unknown = await response.json();
  if (owner !== identityGeneration())
    throw new DOMException("Identity changed.", "AbortError");
  if (!response.ok) {
    const error = (
      value as {
        error?: {
          code?: string;
          message?: string;
          current_revision_id?: string;
          operation_outcome?: "unknown" | "rejected";
          unavailable_scope?: unknown;
        };
      }
    ).error;
    const failure=new ApiError(
      error?.code ?? "unknown",
      error?.message ?? "The request could not be completed.",
      error?.current_revision_id,
      error?.operation_outcome,
      contract.revisionMiss&&error?.unavailable_scope === 'revision' ? 'revision' : undefined,
    );
    // Error evidence is consumed once, at the endpoint boundary, regardless of
    // which view/command initiated it or whether that caller is still mounted.
    observeRequestFailure(owner,contract,failure);
    throw failure;
  }
  if(contract.errors.session==='discovery'&&discovery!==sessionDiscoveryRevision())
    throw new DOMException('Session discovery changed.','AbortError');
  const observation=classifyResponse(contract,value);
  if (options.schema && !Value.Check(options.schema, value)) {
    if(observation.denied)observeSourceDenial(owner);
    throw new ApiError(
      "unsupported_contract",
      "This response does not match the participation contract.",
    );
  }
  if(contract.errors.session!=='unrelated')establishSession();
  return {value:value as T,contract,observation};
}
/** A first dispatch can be rejected directly. An uncertain summary request can
 * be corrected only after the server commits its irreversible expiry refusal. */
export function isDefinitiveRejection(error: unknown, wasUncertain: boolean) {
  if (error instanceof ApiError && error.code === 'summary_preparation_expired' && error.operationOutcome === 'rejected') return true;
  return (
    !wasUncertain &&
    error instanceof ApiError &&
    error.operationOutcome !== "unknown" &&
    [
      "invalid_input",
      "reference_format_required",
      "change_format_required",
      "unavailable",
      "invalid_request",
      "revision_conflict",
      "forbidden",
      "nickname_conflict",
      "credential_limit",
      "saved_limit_reached",
      "following_limit_reached",
      "organization_conflict",
      "moderation_conflict",
      "moderation_limit",
      "moderation_target_unsupported",
      "organization_limit",
      "organization_cycle",
      "proposal_route_changed",
      "summary_already_exists",
      "summary_preparation_expired",
      "summary_preparation_limit",
      "summary_source_limit",
      "summary_coverage_required",
    ].includes(error.code)
  );
}
export interface Intent {
  version: 1;
  sequence: number;
  origin: string;
  instance_id: string;
  participant_id: string;
  slot: string;
  kind: string;
  path: string;
  key: string;
  body: Record<string, unknown>;
  state: "draft" | "uncertain" | "rejected" | "committed";
  created_at: string;
  result?: CommittedView;
  conflict_revision_id?: string;
  blocked_by?: string;
}
export class StaleIntentError extends Error {
  constructor() {
    super(
      "This submission changed in another view. Reload it before continuing.",
    );
  }
}
export class IntentStore {
  readonly prefix: string;
  private readonly owner = identityGeneration();
  constructor(
    readonly instance: string,
    readonly participant: string,
    readonly storage: Storage = localStorage,
    readonly origin = location.origin,
    private readonly locks:
      | Pick<LockManager, "request">
      | undefined = globalThis.navigator?.locks,
  ) {
    this.prefix = `loom.intent.v1:${origin}:${instance}:${participant}:`;
  }
  all(): Intent[] {
    const records: Intent[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(this.prefix)) continue;
      let record: Intent;
      try {
        record = JSON.parse(this.storage.getItem(key)!) as Intent;
      } catch {
        throw new Error(
          "A recovery record is unreadable. Export local storage before attempting another publication.",
        );
      }
      if (
        record.version !== 1 ||
        record.origin !== this.origin ||
        record.instance_id !== this.instance ||
        record.participant_id !== this.participant
      )
        throw new Error("A recovery record has incompatible ownership.");
      if (
        typeof record.key !== "string" ||
        key !== this.prefix + record.key ||
        typeof record.slot !== "string" ||
        typeof record.path !== "string" ||
        typeof record.kind !== "string" ||
        typeof record.created_at !== "string" ||
        (record.blocked_by !== undefined &&
          typeof record.blocked_by !== "string") ||
        !record.body ||
        record.body.idempotency_key !== record.key ||
        !["draft", "uncertain", "rejected", "committed"].includes(record.state)
      )
        throw new Error(
          "A recovery record is incompatible. Preserve it before attempting another publication.",
        );
      // Existing v1 records predate optimistic versions; new unsaved records use 0.
      record.sequence ??= 1;
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 1)
        throw new Error("A recovery record has an incompatible version.");
      for (const field of [record.body.content, record.body.overview]) {
        if (!field || typeof field !== "object") continue;
        const authored = field as { format?: string; references?: unknown };
        if ((authored.format === "loom-markdown-v1" && authored.references !== undefined) ||
          (["loom-markdown-v2", "loom-markdown-v3"].includes(authored.format ?? "") && (!Array.isArray(authored.references) || authored.references.length > 16 ||
            !authored.references.every(ref => Value.Check(ReferenceDeclaration, ref)))) ||
          !["loom-markdown-v1", "loom-markdown-v2", "loom-markdown-v3"].includes(authored.format ?? ""))
          throw new Error("This authored recovery format is unsupported. Export the exact record before continuing.");
      }
      if ('change_note' in record.body && !Value.Check(DraftNote,record.body.change_note))
        throw new Error('The saved note is incompatible. Export the exact record before continuing.');
      if ('change_account' in record.body && !Value.Check(DraftAccount,record.body.change_account))
        throw new Error('The saved change declaration is incompatible. Export the exact record before continuing.');
      const contentFormat=((record.body.content??record.body.overview) as {format?:string}|undefined)?.format;
      if(contentFormat==='loom-markdown-v3' && (!('change_note' in record.body)||!('change_account' in record.body)))
        throw new Error('V3 recovery requires both explicit change fields. Preserve the original journal.');
      if(contentFormat && contentFormat!=='loom-markdown-v3' && ('change_note' in record.body || 'change_account' in record.body))
        throw new Error('Legacy intent cannot contain new change fields. Preserve the original journal.');
      records.push(record);
    }
    return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  private async locked<T>(work: () => T): Promise<T> {
    if (!this.locks)
      throw new Error(
        "This browser cannot safely coordinate drafts across tabs. Use a browser with Web Locks support to publish; existing drafts can still be exported.",
      );
    // The whole bounded journal shares a lock so quota, replacement and cleanup
    // cannot race. Never hold it during a network request.
    // An async callback also releases Node 24's test lock on a rejected write.
    return this.locks.request(this.prefix, async () => {
      if (this.owner !== identityGeneration())
        throw new DOMException("Identity changed.", "AbortError");
      return work();
    });
  }
  private owned(record: Intent) {
    if (
      record.origin !== this.origin ||
      record.instance_id !== this.instance ||
      record.participant_id !== this.participant
    )
      throw new Error("Draft belongs to a different account or instance.");
  }
  private current(record: Intent) {
    this.owned(record);
    const current = this.all().find((item) => item.key === record.key);
    if ((current?.sequence ?? 0) !== record.sequence)
      throw new StaleIntentError();
    return current;
  }
  private sameRequest(a: Intent, b: Intent) {
    return (
      a.kind === b.kind &&
      a.path === b.path &&
      a.slot === b.slot &&
      a.created_at === b.created_at &&
      JSON.stringify(a.body) === JSON.stringify(b.body)
    );
  }
  private write(record: Intent): Intent {
    this.owned(record);
    const others = this.all().filter((item) => item.key !== record.key);
    if (
      others.length >= 32 ||
      new TextEncoder().encode(JSON.stringify([...others, record])).length >
        1048576
    )
      throw new Error(
        "Local recovery storage is full. Export and remove resolved drafts before publishing.",
      );
    const key = this.prefix + record.key,
      value = JSON.stringify(record);
    const prior = this.storage.getItem(key);
    try {
      this.storage.setItem(key, value);
      if (this.storage.getItem(key) !== value) throw new Error(
        "The recovery record could not be saved. Keep the original submission; a dispatched request may already have committed.",
      );
    } catch (error) {
      // A receipt may already be committed remotely. Failed local settlement
      // must preserve the earlier exact command, never replace its custody.
      try {
        if (prior === null) this.storage.removeItem(key);
        else this.storage.setItem(key, prior);
      } catch { /* Storage is unavailable; retain the caller's exact record. */ }
      throw error;
    }
    return record;
  }
  save(record: Intent): Promise<Intent> {
    return this.locked(() => {
      const current = this.current(record);
      if (
        current &&
        current.state !== "draft" &&
        (!this.sameRequest(current, record) ||
          record.state === "draft" ||
          (current.state !== "uncertain" && record.state !== current.state))
      )
        throw new StaleIntentError();
      if (record.state === "uncertain" && record.blocked_by)
        throw new Error(
          "Review the separately saved changes before publishing a new submission.",
        );
      return this.write({ ...record, sequence: record.sequence + 1 });
    });
  }
  saveDraft(record: Intent, body: Record<string, unknown>): Promise<Intent> {
    return this.locked(() => {
      this.owned(record);
      const current = this.all().find((item) => item.key === record.key);
      if (
        (current?.sequence ?? 0) !== record.sequence ||
        (current && current.state !== "draft")
      ) {
        // A stale editor's unsent work is distinct from the exact dispatched
        // operation. Retain it, but require an explicit review before any POST.
        const separate = this.create(
          record.slot,
          record.kind,
          record.path,
          body,
        );
        return this.write({ ...separate, sequence: 1, blocked_by: record.key });
      }
      return this.write({
        ...record,
        sequence: record.sequence + 1,
        body: { ...body, idempotency_key: record.key },
        state: "draft",
      });
    });
  }
  prepareDispatch(
    record: Intent,
    visibleBody: Record<string, unknown>,
  ): Promise<Intent> {
    // Autosave may have failed. The first dispatch must durably capture the
    // visible form; retries must ignore form state and retain the frozen request.
    return this.save({
      ...record,
      state: "uncertain",
      body:
        record.state === "draft"
          ? { ...visibleBody, idempotency_key: record.key }
          : record.body,
    });
  }
  prepareModeration(body:Record<string,unknown>,active:()=>boolean):Promise<Intent> {
    return this.locked(()=>{
      if(!active())throw new DOMException("View changed.","AbortError");
      const target=body.target as {resource_id:string};
      // Comparison identity is canonical; stored transport spelling stays exact.
      if(this.all().some(r=>r.kind==='moderation.set'&&r.state==='uncertain'&&
        String((r.body.target as {resource_id?:string})?.resource_id).toLowerCase()===target.resource_id.toLowerCase()))
        throw new Error('Resolve the existing moderation command for this target before another choice.');
      const record=this.create('moderation:'+target.resource_id.toLowerCase(),'moderation.set','/api/v1/admin/moderation/state',body);
      return this.write({...record,state:'uncertain',sequence:1});
    });
  }
  settle(
    record: Intent,
    outcome: { state: "committed" | "rejected" } & Partial<
      Pick<Intent, "result" | "conflict_revision_id">
    >,
  ): Promise<Intent> {
    return this.locked(() => {
      this.owned(record);
      const current = this.all().find((item) => item.key === record.key);
      if (
        !current ||
        !this.sameRequest(current, record) ||
        current.state === "draft"
      )
        throw new StaleIntentError();
      if (outcome.state === "rejected" && current.sequence !== record.sequence)
        return current;
      // Concurrent status/retry responses may confirm the same operation. A late
      // rejection must never downgrade a confirmed outcome or resurrect removal.
      if (current.state === "committed" || current.state === "rejected")
        return current;
      return this.write({
        ...current,
        state: outcome.state,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.conflict_revision_id
          ? { conflict_revision_id: outcome.conflict_revision_id }
          : {}),
        sequence: current.sequence + 1,
      });
    });
  }
  create(
    slot: string,
    kind: string,
    path: string,
    body: Record<string, unknown>,
  ): Intent {
    const key = crypto.randomUUID();
    return {
      version: 1,
      sequence: 0,
      origin: this.origin,
      instance_id: this.instance,
      participant_id: this.participant,
      slot,
      kind,
      path,
      key,
      body: { ...body, idempotency_key: key },
      state: "draft",
      created_at: new Date().toISOString(),
    };
  }
  remove(record: Intent): Promise<void> {
    return this.locked(() => {
      const current = this.current(record);
      if (!current || current.state === "uncertain")
        throw new StaleIntentError();
      this.storage.removeItem(this.prefix + record.key);
    });
  }
  complete(record: Intent): Promise<void> {
    return this.locked(() => {
      this.owned(record);
      const current = this.all().find((item) => item.key === record.key);
      if (
        !current ||
        current.state === "draft" ||
        !this.sameRequest(current, record)
      )
        throw new StaleIntentError();
      // Administrative success retains no one-time secret or intermediate
      // committed UI state. The acknowledged operation can be retired directly.
      this.storage.removeItem(this.prefix + record.key);
    });
  }
  replace(record: Intent, body = record.body): Promise<Intent> {
    return this.locked(() => {
      const current = this.current(record);
      if (!current || !["rejected", "committed"].includes(current.state))
        throw new Error(
          "Only a definitively rejected or committed request can be replaced.",
        );
      const next = this.create(record.slot, record.kind, record.path, body);
      // Save first: quota or storage failure must leave the original recoverable.
      const saved = this.write({ ...next, sequence: 1 });
      this.storage.removeItem(this.prefix + record.key);
      return saved;
    });
  }
  async correct(record: Intent, body = record.body): Promise<Intent> {
    if (record.state !== "rejected")
      throw new Error("Only a definitively rejected request can be corrected.");
    return this.replace(record, body);
  }
  clear() {
    return this.locked(() => {
      for (const record of this.all())
        this.storage.removeItem(this.prefix + record.key);
    });
  }
}
export function exportDrafts(store: IntentStore) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(store.all(), null, 2)], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "loom-drafts.json";
  link.click();
  URL.revokeObjectURL(url);
}
function binary(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
function base64(value: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function passkey(enrollmentTicket?: string) {
  const registering = !!enrollmentTicket,
    base = "/api/v1/identity/" + (registering ? "register" : "signin");
  const start = await sessionRequest<{
    challenge_id: string;
    options: Record<string, unknown>;
  }>(base + "/start", {
    body: registering ? { ticket: enrollmentTicket } : {},
  });
  const json = start.options;
  const publicKey = {
    ...json,
    challenge: binary(json.challenge as string),
    ...(registering
      ? {
          user: {
            ...(json.user as object),
            id: binary((json.user as { id: string }).id),
          },
          excludeCredentials: (
            (json.excludeCredentials ?? []) as { id: string }[]
          ).map((item) => ({ ...item, id: binary(item.id) })),
        }
      : {
          allowCredentials: (
            (json.allowCredentials ?? []) as { id: string }[]
          ).map((item) => ({ ...item, id: binary(item.id) })),
        }),
  };
  const credential = (
    registering
      ? await navigator.credentials.create({
          publicKey: publicKey as unknown as PublicKeyCredentialCreationOptions,
        })
      : await navigator.credentials.get({
          publicKey: publicKey as unknown as PublicKeyCredentialRequestOptions,
        })
  ) as PublicKeyCredential | null;
  if (!credential) throw new Error("The passkey ceremony was not completed.");
  const response = credential.response;
  const encoded = {
    id: credential.id,
    rawId: base64(credential.rawId),
    type: "public-key",
    clientExtensionResults: credential.getClientExtensionResults(),
    response: registering
      ? {
          clientDataJSON: base64(response.clientDataJSON),
          attestationObject: base64(
            (response as AuthenticatorAttestationResponse).attestationObject,
          ),
          transports: (
            response as AuthenticatorAttestationResponse
          ).getTransports(),
        }
      : {
          clientDataJSON: base64(response.clientDataJSON),
          authenticatorData: base64(
            (response as AuthenticatorAssertionResponse).authenticatorData,
          ),
          signature: base64(
            (response as AuthenticatorAssertionResponse).signature,
          ),
          ...((response as AuthenticatorAssertionResponse).userHandle
            ? {
                userHandle: base64(
                  (response as AuthenticatorAssertionResponse).userHandle!,
                ),
              }
            : {}),
        },
  };
  await sessionRequest(base + "/finish", {
    body: { challenge_id: start.challenge_id, response: encoded },
  });
}
