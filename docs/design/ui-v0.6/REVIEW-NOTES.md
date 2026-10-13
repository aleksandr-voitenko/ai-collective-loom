# Review notes — UI v0.6

## Requested changes

The owner identified repeated topic information in an artifact list already scoped to that topic, ambiguous leaf names in Following, and missing newly followed parents. Inspection of v0.5 established that follows used IDs but the sidebar displayed only five topic entries and only their final names.

## Delivered response

**Following** is now a primary navigation destination instead of a limited sidebar list. It contains explicitly followed topics, discussions, and artifacts with visible paths; search, type filtering, name/path sorting, and 20/50-row pagination; independent topic scope settings; and Unfollow/Undo. A parent and explicitly followed child remain separate. At the point a child is unfollowed, continued parent coverage is explained rather than concealed.

Artifact location is removed only when the selected scope already identifies one direct topic. A descendant scope uses relative locations; unscoped global browsing uses full canonical paths. Search text and the composition of one result page do not determine the columns. Mobile follows the same rule and retains date/contributor metadata.

The finite Updates example now binds its subscription snapshot and coalesces overlapping source reasons. Explicit Refresh applies new follow settings to a new example binding; existing bound results do not silently change. Direct mentions/replies remain eligible without follows. This is a local model, not a claim that event persistence or network recovery exists.

## Review assumptions

New topic follows use This topic only until explicitly changed. That is a proposed initial interaction default; the product requires explicit scope but has not selected that value independently. All fine-grained event preferences, cross-device synchronization, real identity/ownership, and production subscription APIs remain implementation work. No pinning system, mute/exclusion engine, or new content taxonomy was added.

Imported subscriptions are retained by key. The fresh example set includes a parent and child plus two topics called Reviews to make the previously confusing cases immediately reviewable. Sample counts are derived from those records, not invented for screenshots.

## Useful next review

Search Following for “Reviews”, then “Editorial”. Remove the explicit Reviews subscription and inspect the explanation before using Undo. Compare a direct artifact list with the same list including subtopics. On mobile, check whether full paths and scope controls remain comfortable without recreating a dashboard.
