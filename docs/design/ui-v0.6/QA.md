# UI v0.6 verification

## Observed results

The delivered source was exercised by headless Chromium 144.0.7559.96 using Python Playwright. Node 22.16.0 provided JavaScript syntax validation.

| Suite | Passed |
|---|---:|
| Existing browsing/interaction regression checks | 55 |
| Existing discussion, summary, and reply-recovery checks | 37 |
| Existing content-aware topic navigation and creation/proposal checks | 40 |
| New Following and scope-sensitive artifact checks | 48 |
| **Total scripted interaction checks** | **180** |
| Responsive routes × viewport widths | **96** |

The 96 combinations cover 16 routes at 320, 360, 390, 768, 1024, and 1440 pixels. No horizontal document overflow or page-script errors were observed in those combinations. Sixteen screenshots were captured from the delivered HTML. They are browser renderings, not generated picture approximations.

The earlier 132 checks were rerun against this source, not copied as prior results. Their inherited output version label was corrected from 0.5 to 0.6 without changing the observed results. Final result records identify the delivered HTML hash. They use the v0.6 storage key. One obsolete sidebar assertion now checks the followed parent on the dedicated Following page; it still verifies that following records the correct ID and leaves read state unchanged.

The 48 added checks cover more than five followed resources; all three target kinds; full duplicate-name paths; parent/child independence; scope selection; indirect coverage after unfollow; Undo; stable search/filter/page state; keyboard/mobile paths; unavailable/ambiguous legacy targets; sample hydration; preserved Saved/read/draft state; deduplicated update groups; direct attention without subscriptions; unchanged bound intervals until Refresh; and direct/descendant/global artifact location layouts.

## First attempt and corrections

The first new suite passed 47 of 48 checks. The Undo assertion compared JSON strings, incorrectly treating object-property insertion order as part of scope identity. The restored follow sequence and scope values were correct. The test now compares structured dictionaries while still comparing the ordered follow list exactly. The full suite was rerun and passed. The original result and traceback are retained in first-following-attempt.json and first-following-attempt.log.

Visual inspection also found singular copy reading “1 matches” and a toast duplicating the visible post-unfollow feedback. The text now uses “1 match”, and the Following page uses its one contextual feedback region instead of simultaneously repeating the message in a toast. The final source was rebuilt, retested, and recaptured.

## Environment and evidence boundary

A native `file://` navigation attempt returned **ERR_BLOCKED_BY_ADMINISTRATOR**. Subsequent tests used `page.set_content` with the actual standalone HTML, real hash navigation/history and DOM/CSS, plus an explicitly substituted in-memory Storage adapter. Native-file reload persistence, shared local-file origins, and cross-device migration were not established.

Hydrating a newly created in-memory document verifies normalization of recorded values, not real-origin persistent storage. The code is intended to run as local HTML, but that native path could not be exercised in this environment. No HTTP API, PostgreSQL, object-storage provider, authentication, server authorization, retained activity service, model host, real recovery, screen reader, or human study was executed. These results are not product AC/architecture AV acceptance and not an accessibility certification.

The sample Following and Updates collections live in memory. Their test counts do not establish production search capacity, transaction safety, correct concurrent subscription mutations, or notification-delivery semantics.

## Reproduce the recorded browser model

Install Python Playwright and an available Chromium binary in your own environment. The supplied scripts use `/usr/bin/chromium`; adjust that executable path if needed. Then run:

```sh
python build.py
node --check app.js
python tests/browser_checks.py
python tests/discussion_flow_checks.py
python tests/topic_navigation_checks.py
python tests/following_checks.py
python tests/capture_screenshots.py
```

For native-origin validation, perform and record a separate run without the injected Storage adapter. Do not relabel these simulations as native persistence evidence.
