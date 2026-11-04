import type { ActorContext } from '../../src/server/modules/publication/actor.js';
import type {
  ParticipationPublications,
  PublicationKind,
  PublicationRequest,
} from '../../src/server/modules/participation/publications.js';

// Compiled by app:typecheck; these assertions are never executed as requests.
export function publicationKinds(
  publisher: ParticipationPublications,
  actor: ActorContext,
  kind: PublicationKind,
) {
  const closedKind:
    | 'discussion.create'
    | 'reply.create'
    | 'artifact.create'
    | 'revision.publish'
    | 'community.setup'
    | 'summary.create'
    | 'summary.revise' = kind;
  void closedKind;
  // @ts-expect-error A typo must not silently become another operation kind.
  void publisher.publish(actor, 'artifact.creat', {});
  // @ts-expect-error Promotion is owned by a separate publication service.
  void publisher.publish(actor, 'attachment.promote', {});
}

const content = { format: 'loom-markdown-v1' as const, text: 'Typed content', mentions: [] };
const base = { idempotency_key: 'fixture' };
const authored = { ...base, title: 'Title', content };
const accept = (request: PublicationRequest) => request;

export function publicationRequests(request: PublicationRequest) {
  accept({ kind: 'discussion.create', input: { ...authored, area_id: 'area' } });
  accept({
    kind: 'reply.create',
    input: { ...base, content, discussion_id: 'discussion', parent_id: 'parent' },
  });
  accept({ kind: 'artifact.create', input: { ...authored, area_id: 'area' } });
  accept({
    kind: 'revision.publish',
    input: { ...authored, title: null, resource_id: 'resource', expected_revision_id: 'base' },
  });
  accept({
    kind: 'community.setup',
    input: {
      ...base,
      overview: content,
      community_name: 'Community',
      ordinary_area_name: 'Work',
      proposal_area_name: 'Proposals',
    },
  });
  accept({
    kind: 'summary.create',
    input: {
      ...authored,
      discussion_id: 'discussion',
      coverage: { preparation_id: 'preparation' },
    },
  });
  accept({
    kind: 'summary.revise',
    input: {
      ...authored,
      resource_id: 'summary',
      expected_revision_id: 'base',
      coverage: { carry_forward_revision_id: 'base' },
    },
  });

  // @ts-expect-error Reply parent and discussion are required, not optional.
  accept({ kind: 'reply.create', input: { ...base, content } });
  // @ts-expect-error Revision publication requires an exact base revision.
  accept({ kind: 'revision.publish', input: { ...authored, resource_id: 'resource' } });
  // @ts-expect-error Summary publication must declare coverage.
  accept({ kind: 'summary.create', input: { ...authored, discussion_id: 'discussion' } });
  // @ts-expect-error A valid artifact body cannot be paired with a setup operation.
  accept({ kind: 'community.setup', input: { ...authored, area_id: 'area' } });
  const wrongArtifactBody = { ...authored, area_id: 'area', parent_id: 'parent' };
  // @ts-expect-error Fields owned by another operation are forbidden even through a variable.
  accept({ kind: 'artifact.create', input: wrongArtifactBody });

  // Every branch narrows to the schema's required fields without assertions.
  const string = (value: string) => value;
  switch (request.kind) {
    case 'discussion.create':
      return string(request.input.area_id) + request.input.content.text;
    case 'reply.create':
      return string(request.input.parent_id) + string(request.input.discussion_id);
    case 'artifact.create':
      return string(request.input.area_id) + string(request.input.title);
    case 'revision.publish':
      return string(request.input.resource_id) + string(request.input.expected_revision_id);
    case 'community.setup':
      return string(request.input.community_name) + request.input.overview.text;
    case 'summary.create':
      return string(request.input.discussion_id) + ('preparation_id' in request.input.coverage);
    case 'summary.revise':
      return (
        string(request.input.expected_revision_id) +
        ('carry_forward_revision_id' in request.input.coverage)
      );
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}
