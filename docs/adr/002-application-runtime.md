# ADR-002: Application runtime and executable contracts

Status: implemented for the runtime foundation; this expands the imported
ADR-002 proposal only for the decisions below. It does not approve the entire
architecture. The synthetic participation extension below is now available.

## Decision and scope

Use one TypeScript application package and release with Fastify, a React client,
React Router Data Mode, and Vite. Use Node 24.19.0 from `.nvmrc`; application
commands verify that version. Install exact direct versions and retain the resolved
dependency graph in the actual lockfile. The selected core versions are:

| Boundary | Versions |
|---|---|
| TypeScript and execution tooling | TypeScript 5.9.3; tsx 4.23.15 |
| HTTP and browser files | Fastify 5.12.5; @fastify/static 10.1.6 |
| Browser | React/React DOM 19.3.0; React Router 7.18.4; Vite 8.3.4; React plugin 6.1.2 |
| Controlled contracts | TypeBox 0.34.52; TypeBox provider 5.2.0; @fastify/swagger 9.9.2 |
| Database driver | node-postgres 8.23.1; see ADR-003 |

`package.json` and `package-lock.json` remain authoritative for all versions.
No ORM, workspace split, separate service, authentication library, storage client,
or job runtime is selected by this foundation. Those modules need real operations
and their corresponding policy and compatibility evidence before installation.

Keep `dev` as dependency initialization through the existing local bootstrap `up`
flow. `app:dev` runs an API watcher and Vite proxy; separate `app:dev:api` and
`app:dev:web` commands are available. `app:build` cleans generated `dist/` output,
emits the server/contracts and browser, and `app:start` serves both from one process.
No server rendering framework or privileged browser-only API is introduced.
The development proxy owns `/api/` and `/health/` namespaces, including the trailing
slash, so application module URLs such as `/api.ts` remain browser source.
It targets IPv4 or IPv6 loopback according to the configured API bind.

## Contract boundary

Application-controlled TypeBox schemas use a tested JSON Schema Draft 7 subset.
Fastify's Ajv configuration explicitly disables additional-property removal,
type coercion, and default insertion. Closed object schemas reject unsupported
fields. GET/HEAD bodies are rejected; schema-bearing body routes require
`application/json`. Test-only body routes prove numeric/Boolean strings, arrays,
nulls, and unsupported privacy fields are rejected before their handlers run.
They are not registered by production code.

Response schemas allowlist output. Keep request and response schemas distinct
where defaults have different meaning: serialization can supply a response default
even when request default insertion is disabled. Request IDs use a shared UUID
pattern supported by both Ajv and TypeBox's browser value checker, without relying
on an implicitly registered custom format.

Generate OpenAPI **3.0.3** from those route schemas. Enable `convertConstToEnum`
explicitly: TypeBox literals use `const`, while the selected OpenAPI dialect uses
single-value enums. Validate the serialized generated document with Swagger Parser
13.1.0, including references and the actual production route inventory. This is a
verified subset/dialect decision, not a claim that all JSON Schema and OpenAPI
keywords are interchangeable. Extend the compatibility tests before adding new
schema constructs or changing the dialect.

The initial public JSON surfaces are liveness, database readiness, foundation
capabilities, and the generated OpenAPI document. They reveal coarse availability
and explicitly unimplemented participant capabilities. They expose no account,
community, dependency/job detail, table CRUD, or authorization bypass.

Errors contain stable codes, safe messages, server-generated request IDs, and safe
validation paths/rules when applicable. Ignore caller-supplied correlation identity;
it is never a participant principal. Private exceptions, SQL, credentials, headers,
and request bodies are excluded from error payloads and owned diagnostics. Do not
add publication-outcome claims or mutation retry advice to these read-only failures.

Startup validates configuration, built browser assets in web mode, and actual
application-role database access before listening. SIGINT/SIGTERM stop accepting
requests and drain admitted work before closing the pool. Readiness fails during
shutdown, and finishing HTTP/1 responses close keep-alive connections. A ten-second
shutdown deadline reports failure instead of hanging indefinitely. SQL/pool timeout
defaults are described in ADR-003; these are operational defaults, not a measured
product operating envelope.

## Browser and remaining gates

The browser calls the same documented API, validates response shapes, preserves
request cancellation, and uses Data Mode loaders, pending navigation, failure
boundaries, and deliberate retry. It renders no fake participants or discussions.
The default foundation exposes no participant operations. An explicit synthetic
profile now adds sign-in, admission, text participation and bounded retrieval through
the same controllers/services; see ADR-011/015/016/017. No default administrator,
identity header, storage operation, model execution or durable worker is enabled.

Local evidence covers installation/build/typecheck, real PostgreSQL/HTTP lifecycle,
transport contracts, router loading/failure/retry, and development module/proxy
separation. The existing bootstrap checks
remain in CI, with application checks and the isolated runtime suite added. The current participation evidence adds real Chromium and direct HTTPS journeys;
CI execution, hosted deployment, full product scenarios and physical device
validation remain separate gates. Reconsider these choices when a new contract
construct, participant operation, or observed browser/runtime limitation requires it;
do not weaken the product invariants to fit a framework default.

## References

- [Architecture stack/interfaces/repository proposal](../architecture/ai-collective-loom-architecture-v0.3.md): §§3, 14, 15, 17; snapshot unchanged.
- [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/): controlled schemas and explicit Ajv behavior.
- [Swagger generation](https://github.com/fastify/fastify-swagger): dialect and literal conversion.
- [React Router Data Mode](https://reactrouter.com/start/data/installation): browser/router integration.
