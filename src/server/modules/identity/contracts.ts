import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { IdentityError } from './errors.js';

const closed = { additionalProperties: false };
export const Uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
const Nickname = Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_-]{2,31}$' });
const Role = Type.Union([Type.Literal('participant'), Type.Literal('administrator')]);
export const BootstrapInput = Type.Object({ idempotency_key: Uuid, nickname: Nickname }, closed);
export const AccountInput = Type.Object(
  {
    idempotency_key: Uuid,
    nickname: Nickname,
    kind: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
    role: Role,
  },
  closed,
);
export const IssueInput = Type.Object(
  {
    idempotency_key: Uuid,
    participant_id: Uuid,
    kind: Type.Union([Type.Literal('agent'), Type.Literal('enrollment')]),
    purpose: Type.Union([Type.Literal('enroll'), Type.Literal('recover'), Type.Null()]),
    label: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,47}$' }),
    replace_credential_id: Type.Union([Uuid, Type.Null()]),
  },
  closed,
);
export const LifecycleInput = Type.Object(
  {
    idempotency_key: Uuid,
    participant_id: Uuid,
    state: Type.Union([Type.Literal('active'), Type.Literal('suspended'), Type.Literal('revoked')]),
    role: Role,
  },
  closed,
);
export const RenameInput = Type.Object(
  { idempotency_key: Uuid, participant_id: Uuid, nickname: Nickname },
  closed,
);
export const RevokeInput = Type.Object(
  { idempotency_key: Uuid, participant_id: Uuid, credential_id: Uuid },
  closed,
);
export const ReconcileInput = Type.Object(
  {
    idempotency_key: Uuid,
    operation_kind: Type.Union(
      (
        [
          'account.create',
          'credential.issue',
          'account.state',
          'account.rename',
          'credential.revoke',
        ] as const
      ).map((value) => Type.Literal(value)),
    ),
  },
  closed,
);
const Binary = Type.String({ pattern: '^[A-Za-z0-9_-]+$', maxLength: 32768 });
export const RegistrationResponse = Type.Object(
  {
    id: Binary,
    rawId: Binary,
    type: Type.Literal('public-key'),
    response: Type.Object(
      {
        clientDataJSON: Binary,
        attestationObject: Binary,
        transports: Type.Optional(
          Type.Array(
            Type.Union(
              (['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const).map(
                (value) => Type.Literal(value),
              ),
            ),
            { maxItems: 7 },
          ),
        ),
      },
      closed,
    ),
    clientExtensionResults: Type.Object(
      { credProps: Type.Optional(Type.Object({ rk: Type.Optional(Type.Boolean()) }, closed)) },
      closed,
    ),
    authenticatorAttachment: Type.Optional(
      Type.Union([Type.Literal('platform'), Type.Literal('cross-platform')]),
    ),
  },
  closed,
);
export const AuthenticationResponse = Type.Object(
  {
    id: Binary,
    rawId: Binary,
    type: Type.Literal('public-key'),
    response: Type.Object(
      {
        clientDataJSON: Binary,
        authenticatorData: Binary,
        signature: Binary,
        userHandle: Type.Optional(Binary),
      },
      closed,
    ),
    clientExtensionResults: Type.Object({}, closed),
    authenticatorAttachment: Type.Optional(
      Type.Union([Type.Literal('platform'), Type.Literal('cross-platform')]),
    ),
  },
  closed,
);
export const RegisterStart = Type.Object({ ticket: Type.String({ maxLength: 128 }) }, closed);
export const RegisterFinish = Type.Object(
  { challenge_id: Uuid, response: RegistrationResponse },
  closed,
);
export const SignInFinish = Type.Object(
  { challenge_id: Uuid, response: AuthenticationResponse },
  closed,
);
const Descriptor = Type.Object(
  {
    id: Binary,
    type: Type.Literal('public-key'),
    transports: Type.Optional(Type.Array(Type.String())),
  },
  closed,
);
export const RegistrationOptionsResponse = Type.Object(
  {
    challenge_id: Uuid,
    options: Type.Object(
      {
        challenge: Binary,
        rp: Type.Object({ id: Type.String(), name: Type.String() }, closed),
        user: Type.Object({ id: Binary, name: Type.String(), displayName: Type.String() }, closed),
        pubKeyCredParams: Type.Array(
          Type.Object({ type: Type.Literal('public-key'), alg: Type.Literal(-7) }, closed),
        ),
        timeout: Type.Integer(),
        attestation: Type.Literal('none'),
        excludeCredentials: Type.Array(Descriptor),
        authenticatorSelection: Type.Object(
          {
            residentKey: Type.Literal('required'),
            requireResidentKey: Type.Literal(true),
            userVerification: Type.Literal('required'),
          },
          closed,
        ),
        extensions: Type.Object({ credProps: Type.Literal(true) }, closed),
        hints: Type.Array(Type.String()),
      },
      closed,
    ),
  },
  closed,
);
export const AuthenticationOptionsResponse = Type.Object(
  {
    challenge_id: Uuid,
    options: Type.Object(
      {
        rpId: Type.String(),
        challenge: Binary,
        timeout: Type.Integer(),
        userVerification: Type.Literal('required'),
        allowCredentials: Type.Optional(Type.Array(Descriptor)),
        extensions: Type.Optional(Type.Object({}, closed)),
      },
      closed,
    ),
  },
  closed,
);

export type Issue = Static<typeof IssueInput>;
export type Account = Static<typeof AccountInput>;
export type IdentityOperationKind = Static<typeof ReconcileInput>['operation_kind'];
export const semanticVersion = 'identity-prototype-v1';

/** Validate without defaults/coercion. UUID case is transport syntax, not meaning. */
export function input<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new IdentityError('invalid_request');
  const copy = structuredClone(value) as Record<string, unknown>;
  for (const [name, field] of Object.entries(copy))
    if ((name.endsWith('_id') || name === 'idempotency_key') && typeof field === 'string')
      copy[name] = field.toLowerCase();
  return copy as Static<T>;
}
export function requestDigest(kind: string, semanticFields: readonly unknown[]) {
  return createHash('sha256')
    .update(JSON.stringify([semanticVersion, kind, ...semanticFields]))
    .digest('hex');
}
