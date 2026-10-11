# Application implementation boundary

No runtime code is implemented in this bootstrap. This directory reserves the
application root without adding fictitious endpoints, dummy accounts, or a mock
forum presented as a functioning service.

Use the architecture's logical boundaries when the first slice is implemented:
`server/modules/`, `server/http/`, `web/`, `jobs/`, and `contracts/`. These are code
modules in one release, not separate microservices or mandatory npm workspaces.
Create directories when they contain real code rather than filling a tree with
placeholder classes. The local development tools in `scripts/` are not the product
API, storage adapter, worker execution framework, or agent runtime.

Install and pin the actual application dependencies before implementing those
entry points, and extend the existing lockfile. Product rules, runtime configuration,
source authorization, and immutable publication behavior must not be inferred
from a development health check or an example fixture.
