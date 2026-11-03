# Administration routes and layout

`ParticipationApp` replaces Community navigation inside `/loom/admin` and its
children with Administration sections. Branding and the existing account/sign-out
implementation stay in that shell. Back to Loom opens `/loom/updates`; `/loom`
continues to open Topics. Other workspace routes and authorization scopes retain
their existing ownership.

| Route | Section | Mounted content |
| --- | --- | --- |
| `/loom/admin` | Overview | OperationalHealth; secondary diagnostic disclosures |
| `/loom/admin/community` | Community | CommunitySettings |
| `/loom/admin/participants` | Participants | Admission, account lookup, selected credentials |
| `/loom/admin/limits` | Limits | ParticipationRates and FileLimits, independent actions |
| `/loom/admin/search` | Search indexing | SearchAdministration |
| `/loom/admin/file-processing` | File processing | FileTextAdministration |
| `/loom/admin/audit` | Identity audit | IdentityAuditBrowsing, identity/admission history only |

Unknown children show an unavailable page. Navigation uses ordinary exact route
links in a named landmark, with aria-current, accent/background and a selected edge.
The 250px desktop sidebar remains accessible during document scrolling. At 960px
and below, a native modal dialog overlays full-width content. Only one navigation
tree is mounted. Dismissal restores opener focus; successful navigation focuses
the destination heading. Resize closes the modal and releases background blocking.

## Existing URLs and compatibility

Before UI-05, `/loom/admin` mounted admission plus request/file limits, with health,
file text and identity audit disclosures. Community and Search already used the
URLs above. `?intent=<key>` selects an exact private IntentStore attempt in setup,
settings, admission, request-limit and file-policy controls. `intentUrl` generated
the root admin URL for all but settings; Local drafts and useIntent's separate-draft
navigation use it. Search maintenance uses its own identity-bound retained request,
not `intent` or IntentStore. No hash links or query-driven section tabs are added.

Root legacy intent links resolve the retained operation kind: community.setup and
community.settings → Community; account.create and credential.issue → Participants;
participation.rates and file.policy → Limits. Replacement preserves the entire
query string and fragment. Missing/unknown attempts retain their URL and show
explicit recovery-unavailable feedback with Local drafts access. Initial uncertain
setup still takes precedence in the existing focused setup shell.

Mounting a section never dispatches a mutation. Leaving an in-flight write leaves
its exact attempt uncertain for deliberate recovery. Community keeps its dirty-form
guard. One-time credential display warns on route/unload departure and is never
persisted; loss of its authorization lease removes the secret independently.
Search retains its existing exact bounded maintenance custody and generation guards.
The existing administration settings boundary and current server checks remain;
this layout adds no authorization wrapper around neighbouring routes.

## Review reproduction

Use Node 24.19.0 and the existing local Docker/Chromium setup from root README.
Build first, then run:

```
LOOM_ADMIN_NAVIGATION_REVIEW=after npm run test:e2e -- administration.spec.ts --grep 'administration workspace routes'
```

Curated PNGs and provenance go to `/tmp/loom-review-evidence/ui-05/after`, separate
from approved diagnostic bundles. `before` captures the pre-UI-05 built application
using the same isolated fixture and viewports. It must run against the baseline
source/build. No deployed instance, retained pilot or personal credential is used.
