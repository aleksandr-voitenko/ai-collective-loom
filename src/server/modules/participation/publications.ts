import { randomUUID, createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  DiscussionInput,
  ReplyInput,
  ArtifactInput,
  RevisionInput,
  SetupInput,
  type AuthoredContent,
  type NoteContent,
  type ChangeAccountValue,
} from "../../../contracts/participation.js";
import { parseAuthored, validUnicode, validateChangeFields } from "../../../contracts/authored.js";
import { lockAttempt } from "../../application/attempt.js";
import type { SqlTransaction } from "../../db/postgres.js";
import { identityOf, type ActorContext } from "../publication/actor.js";
import { PublicationError } from "../publication/errors.js";
import { canonicalAttemptKey } from "../publication/input.js";
import {
  lockActor,
  lockContext,
  authorizePublication,
  requireRevision,
  commitRevision,
  result,
  safeError,
  type Transactions,
  type Outcome,
  type Resource,
  type Reconciliation,
} from "../publication/publication.js";
import { structureGuard, advanceHierarchy, OrganizationError } from "./organization-context.js";
import { lockReferencePlan, prepareReferences } from "./reference-context.js";
import { SummaryCreateInput, SummaryRevisionInput, type CoverageDeclarationValue } from "../../../contracts/summaries.js";
import { SummaryError, preparationGuard, preparation, expirePreparation, preparedMembers, coverageSet, authorizeMember } from "./summary-context.js";
import type { PreparedCoverage } from "../publication/summary-storage.js";
import { changeMembers, prepareChangeAccount } from './change-context.js';

const schemas: Record<string, TSchema> = {
  "discussion.create": DiscussionInput,
  "reply.create": ReplyInput,
  "artifact.create": ArtifactInput,
  "revision.publish": RevisionInput,
  "community.setup": SetupInput,
  "summary.create": SummaryCreateInput,
  "summary.revise": SummaryRevisionInput,
};
export type PublicationKind = keyof typeof schemas;
export const participationSemanticVersion = "participation-text-v1";
type Request = {
  idempotency_key: string;
  area_id?: string;
  discussion_id?: string;
  parent_id?: string;
  resource_id?: string;
  expected_revision_id?: string;
  title?: string | null;
  content?: AuthoredContent;
  overview?: AuthoredContent;
  community_name?: string;
  ordinary_area_name?: string;
  proposal_area_name?: string;
  proposal_context?: { affected_area_id?: string; expected_settings_version: number };
  coverage?: CoverageDeclarationValue;
  change_note?: NoteContent | null;
  change_account?: ChangeAccountValue | null;
};

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}
export function digestRequest(kind: string, value: unknown, version = participationSemanticVersion) {
  return createHash("sha256")
    .update(
      JSON.stringify([version, kind, ordered(value)]),
    )
    .digest("hex");
}
function prepare(kind: string, value: unknown) {
  const schema = schemas[kind];
  if (!schema || !Value.Check(schema, value))
    throw new PublicationError("invalid_input");
  const input = structuredClone(value) as Request;
  for (const [key, field] of Object.entries(input))
    if (
      (key.endsWith("_id") || key === "idempotency_key") &&
      typeof field === "string"
    )
      (input as Record<string, unknown>)[key] = field.toLowerCase();
  const content = input.content ?? input.overview!;
  if (input.coverage) for (const key of Object.keys(input.coverage)) {
    const coverage = input.coverage as Record<string,string>;
    coverage[key] = coverage[key]!.toLowerCase();
  }
  if (input.proposal_context?.affected_area_id) input.proposal_context.affected_area_id = input.proposal_context.affected_area_id.toLowerCase();
  for (const field of [content, ...(input.change_note ? [input.change_note] : [])]) {
  field.mentions.forEach((entity) => {
    entity.participant_id = entity.participant_id.toLowerCase();
  });
  // Entity order is not semantic. Text, token spelling, line endings and spaces are.
  field.mentions.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  if (field.format !== "loom-markdown-v1") {
    field.references = field.references.map(ref => ({ reference_id: ref.reference_id.toLowerCase(),
      target: { kind: ref.target.kind, resource_id: ref.target.resource_id.toLowerCase(),
        ...(ref.target.revision_id ? { revision_id: ref.target.revision_id.toLowerCase() } : {}) },
      relationship: ref.relationship, rationale: ref.rationale })).sort((a,b) => a.reference_id.localeCompare(b.reference_id));
  }
  }
  if (input.change_account) {
    if ('carry_forward_revision_id' in input.change_account) input.change_account.carry_forward_revision_id = input.change_account.carry_forward_revision_id.toLowerCase();
    else input.change_account.revisions = input.change_account.revisions.map(target => ({...target,
      resource_id: target.resource_id.toLowerCase(), revision_id: target.revision_id.toLowerCase()}))
      .sort((a,b) => a.resource_id.localeCompare(b.resource_id) || a.revision_id.localeCompare(b.revision_id));
  }
  try {
    parseAuthored(content);
    validateChangeFields(content, input);
  } catch {
    throw new PublicationError("invalid_input");
  }
  for (const text of [
    input.title,
    input.community_name,
    input.ordinary_area_name,
    input.proposal_area_name,
  ]) {
    if (text && (text.includes("\0") || !validUnicode(text) || !text.trim()))
      throw new PublicationError("invalid_input");
  }
  const { idempotency_key: _key, ...semantic } = input;
  const version = content.format === 'loom-markdown-v3' ? (kind.startsWith('summary.') ? 'discussion-summary-v2' : 'participation-text-v3')
    : kind.startsWith("summary.") ? "discussion-summary-v1"
    : content.format === "loom-markdown-v2" ? "participation-text-v2" : participationSemanticVersion;
  return { input, content, version, digest: digestRequest(kind, semantic, version) };
}
async function outcome(
  tx: SqlTransaction,
  participant: string,
  kind: string,
  key: string,
) {
  await lockAttempt(tx, participant, kind, key);
  return (
    await tx.query<Outcome>(
      "SELECT id, resource_id, revision_id, semantic_version, request_digest FROM loom.idempotency_records WHERE participant_id=$1 AND operation_kind=$2 AND idempotency_key=$3",
      [participant, kind, key],
    )
  ).rows[0];
}
function open(chain: Resource[]) {
  if (chain.some((resource) => !resource.publication_open))
    throw new PublicationError("forbidden");
}
export class ParticipationPublications {
  constructor(private readonly database: Transactions) {}

  async publish(actorContext: ActorContext, kind: string, value: unknown) {
    const { input, content, digest, version } = prepare(kind, value),
      identity = identityOf(actorContext);
    try {
      const completed = await this.database.transaction(async (tx) => {
        const saved = await outcome(
          tx,
          identity.participantId,
          kind,
          input.idempotency_key,
        );
        // All participant locks precede credential/resource guards in UUID order.
        for (const id of [
          ...new Set([
            identity.participantId,
            ...content.mentions.map((m) => m.participant_id),
            ...(input.change_note?.mentions.map(m => m.participant_id) ?? []),
          ]),
        ].sort()) {
          await tx.query(
            "SELECT id FROM loom.participants WHERE id=$1 FOR SHARE",
            [id],
          );
        }
        const actor = await lockActor(tx, actorContext);
        if (kind === "community.setup" && !actor.administrator)
          throw new PublicationError("forbidden");
        if (saved) {
          const chain = await lockContext(tx, saved.resource_id, "resolution");
          await requireRevision(tx, saved.resource_id, saved.revision_id);
          if (kind === "revision.publish" || kind === "summary.revise")
            await authorizePublication(tx, actor, chain);
          else open(chain);
          if (
            saved.semantic_version !== version ||
            saved.request_digest !== digest
          )
            throw new PublicationError("idempotency_conflict");
          return result(saved, "replayed");
        }
        for (const mention of [...content.mentions, ...(input.change_note?.mentions ?? [])]) {
          const found = await tx.query(
            "SELECT id FROM loom.participants WHERE id=$1 AND state='active' AND kind IN ('human','agent')",
            [mention.participant_id],
          );
          if (!found.rowCount) throw new PublicationError("invalid_input");
        }
        let coverage: PreparedCoverage | undefined;
        if (input.coverage) {
          if ('preparation_id' in input.coverage) {
            await preparationGuard(tx);
            const snapshot = await preparation(tx, actor.participantId, input.coverage.preparation_id,true);
            if (!snapshot.valid) return expirePreparation(tx,snapshot.id);
            coverage = { discussion_id: snapshot.discussion_id, scope: snapshot.scope, preparation_id: snapshot.id,
              carried_from_revision_id: null, members: await preparedMembers(tx, snapshot.id) };
          } else {
            if (kind !== 'summary.revise' || input.coverage.carry_forward_revision_id !== input.expected_revision_id)
              throw new PublicationError('invalid_input');
            const prior = await coverageSet(tx, input.coverage.carry_forward_revision_id);
            if (prior.summary_id !== input.resource_id) throw new PublicationError('unavailable');
            coverage = {...prior, preparation_id: null, carried_from_revision_id: input.coverage.carry_forward_revision_id};
          }
        }
        if (input.proposal_context) {
          // Freeze the designation with the same configuration-before-structure
          // order used by settings. Exact committed retries resolved above.
          await tx.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [0x4c4f4f4d, 3]);
          const configured = (await tx.query<{version:number;proposal_area_id:string|null}>("SELECT version,proposal_area_id FROM loom.community_settings WHERE id=1 FOR SHARE", [])).rows[0]!;
          if (configured.version !== input.proposal_context.expected_settings_version || configured.proposal_area_id !== input.area_id) throw new OrganizationError("proposal_route_changed");
        }
        const described = input.change_account && 'revisions' in input.change_account ? input.change_account.revisions
          : input.change_account && 'carry_forward_revision_id' in input.change_account ? await changeMembers(tx, input.change_account.carry_forward_revision_id) : [];
        if (content.format !== "loom-markdown-v1" || coverage) {
          // Setup must take the exclusive structure guard before any shared plan.
          if (kind === "community.setup") {
            await tx.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [0x4c4f4f4d, 3]);
            await structureGuard(tx, true);
          }
          await lockReferencePlan(tx, [input.resource_id, input.area_id, input.parent_id, coverage?.discussion_id,
            input.proposal_context?.affected_area_id, ...(content.format !== 'loom-markdown-v1' ? content.references.map(ref => ref.target.resource_id) : []),
            ...(input.change_note?.references.map(ref => ref.target.resource_id) ?? []), ...described.map(target => target.resource_id),
            ...(coverage?.members.map(m=>m.contribution_id) ?? [])]
            .filter((id): id is string => !!id), kind === 'summary.create' ? input.discussion_id
              : kind === "revision.publish" || kind === 'summary.revise' ? input.resource_id : undefined);
        }
        if (input.proposal_context?.affected_area_id) await lockContext(tx, input.proposal_context.affected_area_id, "resolution", ["area"]);
        let chain: Resource[],
          resourceId: string,
          title = input.title ?? null;
        if (kind === "revision.publish" || kind === 'summary.revise') {
          chain = await lockContext(tx, input.resource_id!, "publication");
          const resource = chain[0]!;
          if (resource.kind === 'summary' && kind !== 'summary.revise') throw new SummaryError('summary_coverage_required');
          if (kind === 'summary.revise' && (resource.kind !== 'summary' || !coverage || coverage.discussion_id !== resource.owner_resource_id))
            throw new PublicationError('unavailable');
          if (!resource.current_revision_id)
            throw new PublicationError("unavailable");
          await requireRevision(tx, resource.id, resource.current_revision_id);
          await authorizePublication(tx, actor, chain);
          if (resource.current_revision_id !== input.expected_revision_id)
            throw new PublicationError(
              "revision_conflict",
              resource.current_revision_id,
            );
          const old = (
            await tx.query<{ title: string | null; content_format: string }>(
              "SELECT title,content_format FROM loom.revisions WHERE id=$1",
              [resource.current_revision_id],
            )
          ).rows[0]!;
          if (old.content_format === 'loom-markdown-v3' && content.format !== 'loom-markdown-v3')
            throw new PublicationError('change_format_required');
          if (old.content_format === "loom-markdown-v2" && content.format === "loom-markdown-v1")
            throw new PublicationError("reference_format_required");
          if ((old.title === null) !== (title === null))
            throw new PublicationError("invalid_input");
          resourceId = resource.id;
        } else if (kind === 'summary.create') {
          const owners = await lockContext(tx, input.discussion_id!, 'resolution', ['discussion']);
          open(owners);
          if (!coverage || coverage.discussion_id !== input.discussion_id || !coverage.preparation_id) throw new PublicationError('invalid_input');
          if ((await tx.query('SELECT id FROM loom.summaries WHERE discussion_id=$1', [input.discussion_id])).rowCount)
            throw new SummaryError('summary_already_exists');
          // Validate before inserts. A prepared historical revision is valid, but
          // neither the handle nor earlier eligibility reserves current authority.
          if (!(await preparation(tx, actor.participantId, coverage.preparation_id,true)).valid)
            return expirePreparation(tx,coverage.preparation_id);
          for (const member of coverage.members) await authorizeMember(tx, coverage.discussion_id, member);
          resourceId = await this.createResource(tx, actor.participantId, 'summary', input.discussion_id!);
          await tx.query('INSERT INTO loom.summaries(id,discussion_id) VALUES ($1,$2)', [resourceId,input.discussion_id]);
          await tx.query('INSERT INTO loom.resource_editors VALUES ($1,$2)', [resourceId,actor.participantId]);
          chain = await lockContext(tx, resourceId, 'publication', ['summary']);
        } else if (kind === "community.setup") {
          await tx.query(
            "SELECT pg_advisory_xact_lock($1::integer,$2::integer)",
            [0x4c4f4f4d, 3],
          );
          const settings = (
            await tx.query<{ version: number }>(
              "SELECT version FROM loom.community_settings WHERE id=1 FOR UPDATE",
              [],
            )
          ).rows[0];
          if (!settings || settings.version !== 0)
            throw new PublicationError("idempotency_conflict");
          await structureGuard(tx, true);
          if ((await tx.query("SELECT id FROM loom.areas LIMIT 499", [])).rows.length > 498) throw new OrganizationError("organization_limit");
          const areaId = randomUUID(),
            proposalId = randomUUID();
          for (const [id, name, description] of [
            [
              areaId,
              input.ordinary_area_name!,
              "Shared work, questions, and ideas.",
            ],
            [
              proposalId,
              input.proposal_area_name!,
              "Proposals and feedback about this community.",
            ],
          ]) {
            await tx.query(
              "INSERT INTO loom.resources(id,kind) VALUES ($1,'area')",
              [id],
            );
            await tx.query(
              "INSERT INTO loom.areas(id,title,description) VALUES ($1,$2,$3)",
              [id, name, description],
            );
            await tx.query("INSERT INTO loom.area_metadata_revisions(id,area_id,version,title,description,publisher_id) VALUES ($1,$2,1,$3,$4,$5)", [randomUUID(),id,name,description,actor.participantId]);
          }
          await advanceHierarchy(tx);
          resourceId = await this.createResource(
            tx,
            actor.participantId,
            "artifact",
            areaId,
          );
          await tx.query("INSERT INTO loom.artifacts VALUES ($1)", [
            resourceId,
          ]);
          await tx.query("INSERT INTO loom.resource_editors VALUES ($1,$2)", [
            resourceId,
            actor.participantId,
          ]);
          await tx.query(
            "UPDATE loom.community_settings SET version=1, community_name=$1, overview_id=$2, proposal_area_id=$3 WHERE id=1",
            [input.community_name, resourceId, proposalId],
          );
          await tx.query(
            "INSERT INTO loom.participation_audit(id,actor_id,actor_credential_id,operation_kind,target_id,idempotency_key,request_digest,result_version) VALUES ($1,$2,$3,$4,$5,$6,$7,1)",
            [
              randomUUID(),
              actor.participantId,
              actor.credentialId,
              kind,
              resourceId,
              input.idempotency_key,
              digest,
            ],
          );
          chain = await lockContext(tx, resourceId, "publication");
          title = "Community overview";
        } else {
          const owners =
            kind === "reply.create"
              ? await lockContext(tx, input.parent_id!, "resolution")
              : await lockContext(tx, input.area_id!, "resolution", ["area"]);
          open(owners);
          let ownerId = input.area_id!;
          if (kind === "reply.create") {
            const parent = owners[0]!;
            const row = (
              await tx.query<{ discussion_id: string }>(
                "SELECT discussion_id FROM loom.contributions WHERE id=$1",
                [parent.id],
              )
            ).rows[0];
            if (
              parent.kind !== "contribution" ||
              row?.discussion_id !== input.discussion_id ||
              !parent.current_revision_id
            )
              throw new PublicationError("unavailable");
            await requireRevision(tx, parent.id, parent.current_revision_id);
            ownerId = row!.discussion_id;
          } else if (kind === "discussion.create") {
            ownerId = await this.createResource(
              tx,
              actor.participantId,
              "discussion",
              input.area_id!,
            );
          } else if (kind !== "artifact.create")
            throw new PublicationError("invalid_input");
          const resourceKind =
            kind === "artifact.create" ? "artifact" : "contribution";
          resourceId = await this.createResource(
            tx,
            actor.participantId,
            resourceKind,
            ownerId,
          );
          if (kind === "discussion.create")
            await tx.query("INSERT INTO loom.discussions VALUES ($1,$2)", [
              ownerId,
              resourceId,
            ]);
          if (resourceKind === "contribution")
            await tx.query(
              "INSERT INTO loom.contributions(id,discussion_id,parent_id) VALUES ($1,$2,$3)",
              [resourceId, ownerId, input.parent_id ?? null],
            );
          else {
            await tx.query("INSERT INTO loom.artifacts VALUES ($1)", [
              resourceId,
            ]);
            await tx.query("INSERT INTO loom.resource_editors VALUES ($1,$2)", [
              resourceId,
              actor.participantId,
            ]);
          }
          if (kind === "discussion.create" && input.proposal_context?.affected_area_id)
            await tx.query("INSERT INTO loom.discussion_area_references(discussion_id,area_id) VALUES ($1,$2)", [ownerId,input.proposal_context.affected_area_id]);
          // New rows are owned by this transaction. Existing owner locks were taken
          // before insertion; no competing transaction can yet see these identities.
          chain = await lockContext(tx, resourceId, "publication");
        }
        if (kind === 'summary.revise' && coverage?.preparation_id) {
          if (!(await preparation(tx, actor.participantId, coverage.preparation_id,true)).valid)
            return expirePreparation(tx,coverage.preparation_id);
          for (const member of coverage.members) await authorizeMember(tx, coverage.discussion_id, member);
        }
        if (input.change_note && !['artifact','summary'].includes(chain[0]!.kind)) throw new PublicationError('invalid_input');
        if (input.change_account && chain[0]!.kind !== 'contribution') throw new PublicationError('invalid_input');
        const account = input.change_account ? await prepareChangeAccount(tx, resourceId, input.expected_revision_id ?? null, input.change_account) : undefined;
        const noteReferences = input.change_note ? await prepareReferences(tx, resourceId, null, input.change_note.references, 'change_note') : undefined;
        return commitRevision(
          tx,
          actor,
          chain,
          {
            idempotency_key: input.idempotency_key,
            expected_revision_id: input.expected_revision_id ?? null,
            content,
            title,
            mentions: content.mentions,
            ...(coverage ? { coverage } : {}),
            ...(input.change_note ? { changeNote: input.change_note, noteReferences: noteReferences! } : {}),
            ...(account ? { changeAccount: account } : {}),
            ...(content.format !== "loom-markdown-v1" ? { references: await prepareReferences(tx, resourceId,
              input.expected_revision_id ?? null, content.references) } : {}),
          },
          { kind, version, digest },
        );
      });
      if (completed instanceof SummaryError) throw completed;
      return completed;
    } catch (error) {
      if (error instanceof OrganizationError || error instanceof SummaryError) throw error;
      return safeError(error);
    }
  }
  private async createResource(
    tx: SqlTransaction,
    actor: string,
    kind: string,
    owner: string,
  ) {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES ($1,$2,$3,$4)",
      [id, kind, owner, actor],
    );
    return id;
  }
  async reconcile(
    actor: ActorContext,
    kind: string,
    key: string,
  ): Promise<Reconciliation> {
    if (!schemas[kind]) throw new PublicationError("invalid_input");
    key = canonicalAttemptKey(key);
    try {
      return await this.database.transaction(async (tx) => {
        const saved = await outcome(
          tx,
          identityOf(actor).participantId,
          kind,
          key,
        );
        await lockActor(tx, actor);
        if (!saved) return { operation_state: "not_recorded" };
        await lockContext(tx, saved.resource_id, "resolution");
        await requireRevision(tx, saved.resource_id, saved.revision_id);
        return result(saved, "replayed");
      });
    } catch (error) {
      return safeError(error);
    }
  }
}
