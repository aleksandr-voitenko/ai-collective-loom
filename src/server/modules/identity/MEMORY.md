# Identity administration browsing

`AdministrationBrowsing` behind `IdentityAdministration.browsing` owns ADR-035's
additive `administration-pages-1` POST queries and exact current account lookup.
Legacy GET arrays retain their first100-row behavior; browser/direct-client full
discovery must use the new operations. Mutations, digests/outcomes and one-time
secret rules remain in administration.ts/authentication.ts and ADR-004/015.

Migration0025 adds three fixed private version rows and statement-level triggers
for participant, credential and identity-audit changes, with matching keyset indexes.
No per-cursor row set, activity clock or read audit is retained. Credential versions
cover all targets, including new sessions; account versions include internal changes.
Each page uses its own RR snapshot and current account/credential/parent/admin guards
before token/target inspection. Committed version changes require explicit restart;
uncommitted/later commits are outside the final page's observation. This is neither
an export snapshot nor durable event consumption. Audit keys preserve microseconds. Extract only UUID/time keys into cursor
positions: structural TypeScript typing does not remove metadata DTO fields, and
copying a large retained label would violate the independent cursor input bound.

Synthetic bounds:4KiB request,1024-byte ASCII cursor,25items/32KiB complete JSON,
limit+1 returned candidates,1s statement/lock deadlines. Oversized first item gives
page_budget_exceeded without skipping; lookup has the same32KiB ceiling. Stored
credential state and expires_at stay separate; expiry never removes retained history.
AES-GCM process keys bind participant/collection/target/version/order contract for
one fixed10-minute TTL. API restart, expiry and changes have distinct actionable
errors; replacement credentials still require current authority on every request.

`tests/integration/identity-browsing.test.ts` compares complete >100 eligible sets,
whole-table noninterference, populated upgrades, actual HTTPS and PostgreSQL waiters.
Browser page lifetime/focus and private recovery constraints live in web memory.
The standalone administration-client.mjs saves one0600 metadata page per invocation.

Authenticated HTTP handlers additionally admit through `../rates/accounting.ts`
after channel/CSRF validation. Identity and administrator operations use the bounded
recovery/control category; ceremonies keep the existing authentication throttle.
Stable participant IDs share rate budgets across sessions/credentials. ADR-038 owns
policy defaults/ranges; this does not replace identity caps or current authority.

Transfer hooks and handlers reauthenticate through the same actor boundary. A
request-owned admission promise charges once without caching or skipping current
authority checks; never count repeated verification as another HTTP request.
