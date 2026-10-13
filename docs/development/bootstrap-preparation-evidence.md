# Bootstrap preparation evidence (supplied bundle)

> Historical supplied-bundle record. Versions, results and open items below describe
> its preparation environment. See the [current development guide](README.md) for
> the current state; these checks were not rerun when this record was added to Git.

For current local adoption evidence, see
[bootstrap-evidence.md](bootstrap-evidence.md).

The following records were supplied with the patch and describe its preparation,
not commands rerun or container results observed during adoption.

## Execution environment

Observed runtime: Node.js **22.16.0**, npm **10.9.2**, Git **2.47.3** on Linux.
Node 24 remains the planned application target; the `.nvmrc` candidate has not
been executed in this preparation environment. The bootstrap package explicitly
supports Node 22.16+ and Node 24 so the native tooling can be exercised honestly.

The GitHub connector supplied repository contents and current tree/history.
Direct Git cloning failed because the shell could not resolve `github.com`.
A package-registry request failed with `EAI_AGAIN` for `registry.npmjs.org`.
Docker and PostgreSQL client binaries are unavailable. These restrictions were not
bypassed or replaced by claimed cloud or container execution.

## Checks actually executed

| Command or check | Observed result | What this supports |
|---|---|---|
| `npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund` | Passed. | A real lockfile for the zero-dependency bootstrap package was generated. |
| `npm ci --offline --ignore-scripts --no-audit --no-fund` | Passed in the reconstructed validation tree. | The bootstrap package/lockfile agree; no application packages were installed. |
| `npm run check:docs` | Passed. | Exact baseline hashes; 101 requirement IDs and 61 product acceptance scenario IDs mapped; 42 illustrative JSON blocks parse; imported companion links resolve. Not product acceptance. |
| `npm test` | **26 tests passed**, zero failed/skipped. | Restricted local configuration, exclusive credential creation, endpoint/reset safeguards, migration-plan validation, baseline and JSON checks. |
| `npm run test:hooks` | **5 existing tests passed**, zero failed/skipped. | Existing hook-installation plan behavior. The installer and test file were copied unchanged and checked against their repository Git blob hashes. No hook was installed into the remote repository. |
| `npm run check` | Passed with both suites: **31 tests**. | The combined expected dependency-free check path completed in this environment. |
| `node --check` on all added script/test `.mjs` files | Passed. | JavaScript syntax, not dependency/service behavior. |
| `bash -n infra/postgres/10-roles.sh` | Passed. | Shell syntax; the SQL statements were not run. |
| YAML parsing and targeted structural assertions | Passed. | Compose/workflow syntax as parsed and declared loopback ports, volumes, candidate images, and read-only CI permission scope. This is not `docker compose config` or a workflow run. |
| `node scripts/local.mjs doctor` | Exited 1 with the explicit Docker-unavailable diagnostic. | The missing prerequisite is reported as failure, not a passed integration check or anonymous fallback. |

Test names and generation checks do not establish actual SQL transaction,
role-enforcement, or S3 behavior. The local integration suite contains real-service
assertions, but those assertions have not executed here.
