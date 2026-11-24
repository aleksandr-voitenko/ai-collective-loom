# ADR-046: Topic directory observation

Status: implementation decision for participation-1, guide 30.

## Directory boundary

A reader can be partway through Topics or the direct children of one topic.
A title edit, insertion or move beyond the first page can affect that directory.
The global hierarchy version also advances for changes to unrelated directories
and discussions. These two facts need different notices.

Migration 0034 keeps a derived row for the implicit root and each typed area.
Organization writes already serialize under the exclusive structure guard.
Triggers update the affected scope on area insertion, title or description
changes, direct moves and changes to local availability. Both endpoints of a
move get a new version. Community setup follows the same insertion path. The
migration initializes existing directory rows and their locally open child counts.
Resource ownership remains the source of parentage.

A directory has inherited closure when its parent chain prevents contributions
and at least one active, locally open direct child would otherwise accept them.
An ancestor can close and reopen between two polls, leaving that bit unchanged.
When a closure or move changes an area's effective contribution state, the
writer also advances versions for the directories whose direct children gained
or lost inherited closure. It compares at most two twelve-topic parent paths
and follows indexed, active, locally open area edges within the existing
500-topic, twelve-level limit. A locally closed branch masks changes above it,
and an empty directory has no child label to update. This work runs in the same
transaction as the organization change, including writes from earlier clients.
A different hierarchy version alone tells a client with a continuation that it
must obtain a fresh traversal.

## Read and work bounds

An authenticated client may request `GET /api/v1/organization/children?observe=1`,
optionally adding `parent_id`. The list returns its observation boundary in the
same guarded transaction as the accepted rows. A later page uses the existing
cursor and validation. Retain the first page's boundary across those requests.

`GET /api/v1/organization/children/observation` accepts the same optional parent.
Each call checks the current actor and the scope's current availability. The
root read looks up the singleton hierarchy row and one primary-keyed directory
row. Subtopics additionally resolves at most 12 owner resources with a thirteenth
lookahead for overflow, locks them by exact key and checks their typed area keys.
Each result carries just the parent, directory version, inherited closure and
hierarchy version, capped at 256 bytes. Agents can read any selected scope on
demand. The observation has no continuation, client-side checkpoint custody,
publication or private-state effects.

## Browser ownership and application

The browser schedules one check at a time while the route is visible and online.
Subtopics listens to the mounted disclosure's native toggle. Temporary failures
retain the notice and back off. Validated retry guidance applies to the owner
even across a replacement of its displayed traversal. Authorization withdrawal
uses the same protected-read boundary as ordinary browsing.

Show updated captures a visible row, its title’s viewport offset, the loaded page
count and the tail. A partly visible description can anchor its row even after
the title scrolls behind the controls. Each explicit batch reads at most eight
pages, including empty pages. A retained tail can lie further down the new
ordering. Reaching the fresh end also settles the goal, including when a topic
moved away. The browser adopts the rows, fresh continuation and first-page
boundary together. An observation that already established a later directory or
hierarchy version remains pending against that replacement. Stable React keys
preserve surviving row links. A temporary failure keeps the prepared prefix for
exact retry. An incompatible cursor or
page requires an explicit restart. Reload continues to discard the old extent.

Current navigation retains one return target per history entry. Background
observations do not touch it. Application corrects the visible offset when the
reader has not taken control, and can use a nearby surviving link when the
anchor disappears. A subsequent link activation records the newly accepted
extent in the existing owner. If the directory empties, the empty state and
controls provide the local fallback. Revisit the scoped evidence if authorization
starts varying per direct child or if new displayed directory fields gain separate writers.
