import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { UUID, closed } from './participation.js';

export const administrationContract = 'administration-pages-1';
export const administrationLimits = Object.freeze({
  items: 25,
  bytes: 32768,
  cursor: 1024,
  seconds: 600,
  queryMilliseconds: 1000,
});
export const AdministrationPageInput = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: administrationLimits.items })),
    max_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: administrationLimits.bytes })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: administrationLimits.cursor })),
  },
  closed,
);
export const CredentialPageInput = Type.Object(
  { ...AdministrationPageInput.properties, participant_id: UUID },
  closed,
);
export const AccountLookupInput = Type.Union([
  Type.Object({ id: UUID }, closed),
  Type.Object({ nickname: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{2,31}$' }) }, closed),
]);
export const AdministrativeAccount = Type.Object(
  {
    id: UUID,
    nickname: Type.String(),
    kind: Type.String(),
    role: Type.String(),
    state: Type.String(),
  },
  closed,
);
const nullableId = Type.Union([UUID, Type.Null()]);
export const AdministrativeCredential = Type.Object(
  {
    id: UUID,
    kind: Type.String(),
    label: Type.String(),
    state: Type.String(),
    expires_at: Type.Union([Type.String(), Type.Null()]),
    created_at: Type.String(),
    parent_credential_id: nullableId,
  },
  closed,
);
export const IdentityAuditRecord = Type.Object(
  {
    id: UUID,
    actor_id: nullableId,
    actor_credential_id: nullableId,
    authority: Type.String(),
    target_id: UUID,
    action: Type.String(),
    operation_id: UUID,
    recorded_at: Type.String(),
  },
  closed,
);
function page(item: TSchema, collection: string, order: string) {
  return Type.Object(
    {
      contract: Type.Literal(administrationContract),
      scope: Type.Object(
        {
          collection: Type.Literal(collection),
          participant_id: nullableId,
          order: Type.Literal(order),
          consistency: Type.Literal('restart-on-change'),
        },
        closed,
      ),
      items: Type.Array(item, { maxItems: administrationLimits.items }),
      next_cursor: Type.Union([
        Type.String({ maxLength: administrationLimits.cursor }),
        Type.Null(),
      ]),
      complete: Type.Boolean(),
      expires_at: Type.String(),
    },
    closed,
  );
}
export const AccountPage = page(AdministrativeAccount, 'accounts', 'id');
export const CredentialPage = page(AdministrativeCredential, 'credentials', 'id');
export const IdentityAuditPage = page(IdentityAuditRecord, 'audit', 'recorded_at,id');
export type AdministrativeAccountView = Static<typeof AdministrativeAccount>;
export type AdministrativeCredentialView = Static<typeof AdministrativeCredential>;
export type IdentityAuditRecordView = Static<typeof IdentityAuditRecord>;
export type AdministrationPageQuery = Static<typeof AdministrationPageInput>;
export interface AdministrationPageView<T> {
  contract: typeof administrationContract;
  scope: {
    collection: string;
    participant_id: string | null;
    order: string;
    consistency: 'restart-on-change';
  };
  items: T[];
  next_cursor: string | null;
  complete: boolean;
  expires_at: string;
}
