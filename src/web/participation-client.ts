import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { CommittedView } from "../contracts/participation.js";

export interface Self {
  participant_id: string;
  credential_id: string;
  nickname: string;
  kind: string;
  role: string;
  csrf?: string;
}
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly currentRevision?: string,
    readonly operationOutcome?: "unknown",
  ) {
    super(message);
  }
}
let generation = 0;
export function identityGeneration() {
  return generation;
}
export function invalidateIdentity() {
  generation++;
  window.dispatchEvent(new Event("loom-identity"));
}
export function announceIdentityChange() {
  localStorage.setItem("loom.identity-change", crypto.randomUUID());
  invalidateIdentity();
}
export async function request<T>(
  path: string,
  options: {
    body?: unknown;
    self?: Self;
    signal?: AbortSignal;
    schema?: TSchema;
  } = {},
): Promise<T> {
  const owner = generation;
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
  if (owner !== generation)
    throw new DOMException("Identity changed.", "AbortError");
  if (!response.ok) {
    const error = (
      value as {
        error?: {
          code?: string;
          message?: string;
          current_revision_id?: string;
          operation_outcome?: "unknown";
        };
      }
    ).error;
    throw new ApiError(
      error?.code ?? "unknown",
      error?.message ?? "The request could not be completed.",
      error?.current_revision_id,
      error?.operation_outcome,
    );
  }
  if (options.schema && !Value.Check(options.schema, value))
    throw new ApiError(
      "unsupported_contract",
      "This response does not match the participation contract.",
    );
  return value as T;
}
/** Only a first dispatch's explicit rejection can release an intent for correction. */
export function isDefinitiveRejection(error: unknown, wasUncertain: boolean) {
  return (
    !wasUncertain &&
    error instanceof ApiError &&
    error.operationOutcome !== "unknown" &&
    [
      "invalid_input",
      "invalid_request",
      "revision_conflict",
      "forbidden",
      "nickname_conflict",
      "credential_limit",
    ].includes(error.code)
  );
}
export interface Intent {
  version: 1;
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
}
export class IntentStore {
  readonly prefix: string;
  constructor(
    readonly instance: string,
    readonly participant: string,
    readonly storage: Storage = localStorage,
    readonly origin = location.origin,
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
        !record.body ||
        record.body.idempotency_key !== record.key ||
        !["draft", "uncertain", "rejected", "committed"].includes(record.state)
      )
        throw new Error(
          "A recovery record is incompatible. Preserve it before attempting another publication.",
        );
      records.push(record);
    }
    return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  save(record: Intent) {
    if (
      record.origin !== this.origin ||
      record.instance_id !== this.instance ||
      record.participant_id !== this.participant
    )
      throw new Error("Draft belongs to a different account or instance.");
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
    this.storage.setItem(key, value);
    if (this.storage.getItem(key) !== value)
      throw new Error(
        "The publication intent could not be saved. Nothing was sent.",
      );
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
  remove(record: Intent) {
    this.storage.removeItem(this.prefix + record.key);
  }
  correct(record: Intent, body = record.body): Intent {
    if (
      record.origin !== this.origin ||
      record.instance_id !== this.instance ||
      record.participant_id !== this.participant
    )
      throw new Error("Draft belongs to a different account or instance.");
    if (
      record.state !== "rejected" ||
      this.all().find((r) => r.key === record.key)?.state !== "rejected"
    )
      throw new Error("Only a definitively rejected request can be corrected.");
    const next = this.create(record.slot, record.kind, record.path, body);
    // Persist the replacement before removing the rejected attempt. A failed
    // storage write must leave the original recoverable, never silently lose it.
    this.save(next);
    this.remove(record);
    return next;
  }
  clear() {
    for (const record of this.all()) this.remove(record);
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
  const start = await request<{
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
  await request(base + "/finish", {
    body: { challenge_id: start.challenge_id, response: encoded },
  });
}
