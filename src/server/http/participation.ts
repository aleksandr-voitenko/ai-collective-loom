import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type TSchema } from "@sinclair/typebox";
import * as C from "../../contracts/participation.js";
import { PublicationError } from "../modules/publication/errors.js";
import { IdentityError } from "../modules/identity/errors.js";
import type { IdentityAuthentication } from "../modules/identity/authentication.js";
import type { IdentityAdministration } from "../modules/identity/administration.js";
import { ParticipationPublications } from "../modules/participation/publications.js";
import {
  ParticipationRetrieval,
  RetrievalError,
  type PageOptions,
} from "../modules/participation/retrieval.js";
import { ParticipationAdministration } from "../modules/participation/administration.js";
import type { Transactions } from "../modules/publication/publication.js";
import { registerIdentityRoutes } from "./identity.js";
import { classifyError } from "./errors.js";
import { participationGuide } from "../../contracts/guide.js";
import { registerSavedItems } from "./saved-items.js";
import { SavedItemsError } from "../modules/participation/saved-items.js";
import { registerOrganization } from "./organization.js";
import { OrganizationError } from "../modules/participation/organization-context.js";
import { registerSearch } from './search.js';
import { registerNotifications } from './notifications.js';
import { NotificationError } from '../modules/notifications/retrieval.js';
import { FollowingError } from '../modules/following/context.js';
import { registerFollowing } from './following.js';
import { SearchError } from '../modules/search/search.js';
import { registerReferences } from './references.js';
import { registerChanges } from './changes.js';
import { ReferenceError } from '../modules/participation/references.js';
import { registerSummaries } from './summaries.js';
import { SummaryError } from '../modules/participation/summary-context.js';

export interface ParticipationServices {
  database: Transactions;
  authentication: IdentityAuthentication;
  administration: IdentityAdministration;
}
export function participantError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  let code: string,
    message: string,
    status: number,
    action = "correct_request",
    current: string | null | undefined,
    minimum: number | undefined;
  if (error instanceof PublicationError) {
    code = error.code;
    message = error.message;
    current = error.current_revision_id;
    status = {
      invalid_input: 400,
      reference_format_required: 409,
      change_format_required: 409,
      invalid_actor: 401,
      unavailable: 404,
      forbidden: 403,
      revision_conflict: 409,
      idempotency_conflict: 409,
      retryable: 503,
      service_unavailable: 503,
    }[code as PublicationError["code"]];
  } else if (error instanceof IdentityError) {
    code = error.code;
    message = error.message;
    status = error.status;
  } else if (error instanceof SummaryError) {
    code=error.code;message=error.message;
    status=code==='summary_source_limit'||code==='summary_preparation_limit'?429:409;
    action=code==='summary_changed'?'replay_view':code==='summary_already_exists'?'inspect_discussion_summary':
      code==='summary_preparation_expired'?'retain_draft_and_reconcile':'review_declaration';
  } else if (error instanceof FollowingError) {
    code=error.code;message=error.message;
    status=code==='shared_descriptor_expired'||code==='shared_history_gap'?410:code==='shared_work_limit'||code==='following_limit_reached'?429:409;
    action=code==='shared_descriptor_expired'?'renew_traversal':code==='shared_visibility_replay_required'?'replay_retained_history':
      code==='shared_history_gap'?'resynchronize_retained_content':code==='shared_epoch_changed'?'deployment_recovery_required':
      code==='shared_definition_changed'?'start_retained_history':code==='following_collection_changed'?'replay_view':'retry_same_request';
  } else if (error instanceof NotificationError) {
    code=error.code;message=error.message;
    status=code==='notification_descriptor_expired'||code==='notification_history_gap'?410:code==='notification_work_limit'?429:409;
    action=code==='notification_descriptor_expired'?'renew_traversal':code==='visibility_replay_required'?'replay_retained_history':
      code==='notification_history_gap'?'resynchronize_retained_history':code==='notification_epoch_changed'?'deployment_recovery_required':
      code==='notification_view_changed'||code==='notification_work_limit'?'retry_same_request':'correct_request';
  } else if (error instanceof ReferenceError) {
    code=error.code; message=error.message;
    status=code==='references_changed'?409:429;
    action=code==='references_changed'?'replay_view':'review_synthetic_limit';
  } else if (error instanceof SearchError) {
    code=error.code; message=error.message;
    status=code==='search_changed'?409:code==='search_work_limit'?429:400;
    action=code==='search_changed'?'replay_view':code==='search_work_limit'?'review_synthetic_limit':'correct_request';
  } else if (error instanceof OrganizationError) {
    code = error.code;
    message = error.message;
    status = code === "organization_limit" ? 429 : 409;
    action = code === "organization_limit" ? "review_synthetic_limit" : "refresh_and_review";
  } else if (error instanceof SavedItemsError) {
    code = error.code;
    message = error.message;
    status = code === "saved_collection_changed" ? 409 : 429;
    action = code === "saved_collection_changed" ? "replay_view" : "review_synthetic_limit";
  } else if (error instanceof RetrievalError) {
    code = error.code;
    message =
      code === "invalid_cursor"
        ? "This continuation is unavailable. Start this view again."
        : "The requested response budget cannot hold this representation.";
    status = 400;
    minimum = error.minimum_response_bytes;
  } else {
    const failure = classifyError(error, request.id);
    code = failure.body.error.code;
    message = failure.body.error.message;
    status = failure.status;
  }
  if (status === 401 || status === 403)
    action = "reauthenticate_or_request_authority";
  if (code === "revision_conflict") action = "compare_and_resubmit";
  if (code === "invalid_cursor") action = "replay_view";
  if (code === "idempotency_conflict" || status >= 500)
    action = "reconcile_operation";
  const personalRead = request.routeOptions.url === '/api/v1/me/notifications/query' ||
    request.routeOptions.url === '/api/v1/me/notifications/:id' || request.routeOptions.url?.startsWith('/api/v1/shared-changes/');
  if (personalRead && status >= 500) action = 'retry_same_request';
  return reply
    .code(status)
    .send({
      error: {
        code,
        message,
        request_id: request.id,
        recovery: { action },
        ...(current !== undefined ? { current_revision_id: current } : {}),
        ...(minimum ? { minimum_response_bytes: minimum } : {}),
        ...(error instanceof SummaryError && error.definitive ? { operation_outcome: "rejected" } : {}),
        ...(status >= 500 && request.method === "POST" && !personalRead
          ? { operation_outcome: "unknown" }
          : {}),
      },
    });
}
export async function registerParticipation(
  app: FastifyInstance,
  services: ParticipationServices,
) {
  const actor = await registerIdentityRoutes(app, services);
  app.setErrorHandler(participantError);
  registerSavedItems(app, services.database, actor);
  registerOrganization(app, services.database, actor);
  registerSearch(app, services.database, actor);
  registerNotifications(app, services.database, actor);
  registerFollowing(app, services.database, actor);
  registerReferences(app, services.database, actor);
  registerChanges(app, services.database, actor);
  registerSummaries(app, services.database, actor);
  const publications = new ParticipationPublications(services.database),
    reads = new ParticipationRetrieval(services.database),
    admin = new ParticipationAdministration(services.database);
  const empty = Type.Object({}, C.closed),
    params = Type.Object({ id: C.UUID }, C.closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((code) => [
      code,
      C.ParticipationError,
    ]),
  );
  function command(path: string, kind: string, schema: TSchema) {
    app.post(
      "/api/v1/" + path,
      {
        bodyLimit: C.limits.requestBytes,
        schema: {
          operationId: kind.replaceAll(".", "_"),
          body: schema,
          querystring: empty,
          response: { ...errors, 201: C.Committed },
        },
      },
      async (request, reply) => {
        const result = await publications.publish(
          await actor(request),
          kind,
          request.body,
        );
        return reply.code(201).send(result);
      },
    );
  }
  command("discussions", "discussion.create", C.DiscussionInput);
  command("replies", "reply.create", C.ReplyInput);
  command("artifacts", "artifact.create", C.ArtifactInput);
  command("revisions", "revision.publish", C.RevisionInput);
  command("community/setup", "community.setup", C.SetupInput);
  app.post(
    "/api/v1/operations/status",
    {
      schema: {
        operationId: "reconcilePublication",
        body: C.StatusInput,
        querystring: empty,
        response: { ...errors, 200: C.Reconciled },
      },
    },
    async (request) => {
      const input = request.body as {
        operation_kind: string;
        idempotency_key: string;
      };
      return publications.reconcile(
        await actor(request),
        input.operation_kind,
        input.idempotency_key,
      );
    },
  );
  app.get(
    "/api/v1/community",
    {
      schema: {
        operationId: "getCommunity",
        querystring: empty,
        response: { ...errors, 200: C.Onboarding },
      },
    },
    async (request) => reads.onboarding(await actor(request)),
  );
  app.get(
    "/api/v1/guide",
    {
      schema: {
        operationId: "getParticipationGuide",
        querystring: empty,
        response: {
          ...errors,
          200: Type.Object(
            {
              contract_version: Type.Literal(C.contractVersion),
              guide_revision: Type.Literal(C.guideRevision),
              text: Type.String(),
            },
            C.closed,
          ),
        },
      },
    },
    async (request) => {
      await actor(request);
      return participationGuide;
    },
  );
  app.get(
    "/api/v1/discussions/:id",
    {
      schema: {
        operationId: "getDiscussion",
        params,
        querystring: empty,
        response: { ...errors, 200: C.Discussion },
      },
    },
    async (request) =>
      reads.discussion(
        await actor(request),
        (request.params as { id: string }).id.toLowerCase(),
      ),
  );
  app.get(
    "/api/v1/areas/:id",
    {
      schema: {
        operationId: "getArea",
        params,
        querystring: empty,
        response: { ...errors, 200: C.Area },
      },
    },
    async (request) =>
      reads.area(
        await actor(request),
        (request.params as { id: string }).id.toLowerCase(),
      ),
  );
  app.get(
    "/api/v1/contributions/:id/context",
    {
      schema: {
        operationId: "getContributionContext",
        params,
        querystring: C.BudgetInput,
        response: { ...errors, 200: C.ContributionContext },
      },
    },
    async (request) =>
      reads.contribution(
        await actor(request),
        (request.params as { id: string }).id.toLowerCase(),
        (request.query as PageOptions).max_response_bytes,
      ),
  );
  for (const exact of [false, true])
    app.get(
      "/api/v1/resources/:id" + (exact ? "/revisions/:revision" : ""),
      {
        schema: {
          operationId: exact ? "getExactRevision" : "getCurrentRevision",
          params: exact
            ? Type.Object({ id: C.UUID, revision: C.UUID }, C.closed)
            : params,
          querystring: C.BudgetInput,
          response: { ...errors, 200: C.Revision },
        },
      },
      async (request) => {
        const p = request.params as { id: string; revision?: string };
        return reads.detail(
          await actor(request),
          p.id.toLowerCase(),
          p.revision?.toLowerCase(),
          (request.query as PageOptions).max_response_bytes,
        );
      },
    );
  for (const [path, kind] of [
    ["areas", "areas"],
    ["artifacts", "artifacts"],
    ["participants", "participants"],
    ["contacts", "contacts"],
    ["areas/:id/discussions", "discussions"],
    ["areas/:id/artifacts", "artifacts"],
    ["contributions/:id/children", "children"],
    ["contributions/:id/ancestors", "ancestors"],
    ["resources/:id/history", "revisions"],
  ] as const) {
    app.get(
      "/api/v1/" + path,
      {
        schema: {
          operationId: "list_" + path.replaceAll(/[/:]/g, "_"),
          params: path.includes(":id") ? params : empty,
          querystring: C.PageInput,
          response: { ...errors, 200: C.Page },
        },
      },
      async (request) =>
        reads.list(
          await actor(request),
          kind,
          (request.params as { id?: string }).id?.toLowerCase() ?? "all",
          request.query as PageOptions,
        ),
    );
  }
  const adminResult = Type.Object(
    {
      operation_state: Type.Literal("committed"),
      operation_id: C.UUID,
      version: Type.Integer(),
    },
    C.closed,
  );
  for (const [path, kind, schema] of [
    ["community/settings", "community.settings", C.SettingsInput],
    ["editors", "artifact.editors", C.EditorsInput],
  ] as const)
    app.post(
      "/api/v1/" + path,
      {
        schema: {
          operationId: kind.replaceAll(".", "_"),
          body: schema,
          querystring: empty,
          response: { ...errors, 200: adminResult },
        },
      },
      async (request) => admin.change(await actor(request), kind, request.body),
    );
  app.get(
    "/api/v1/resources/:id/editors",
    {
      schema: {
        operationId: "getEditors",
        params,
        querystring: empty,
        response: {
          ...errors,
          200: Type.Object(
            {
              resource_id: C.UUID,
              version: Type.Integer(),
              can_manage: Type.Boolean(),
              editors: Type.Array(C.Participant, { maxItems: 32 }),
            },
            C.closed,
          ),
        },
      },
    },
    async (request) =>
      reads.editors(
        await actor(request),
        (request.params as { id: string }).id.toLowerCase(),
      ),
  );
}
