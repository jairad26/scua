# macOS compatibility and latency matrix

SCUA records compatibility by generic action class, not by adding application-
specific tools. A row is evidence about an application's Accessibility or CDP
surface; it is not a permanent allowlist.

## Live baseline — 2026-08-19

| Surface | Evidence exercised | Background delivery | Verification | Observed latency |
|---|---|---|---|---|
| Managed Chromium fixture | CDP button press, textbox replacement, checkbox press, immutable successor | Yes (`cdp`) | Newly verified semantic postcondition | 0.71–0.74 s/action with an intentional 0.70 s fixture delay |
| Existing-window Chrome workspace | Four logical actors concurrently created inactive owned tabs in one group, performed four checked mutations, rejected cross-actor state access, handed off one tab, and cleaned up only the workspace | Yes (`chrome.debugger`), selected user tab unchanged | Four distinct resources and one group/window/workspace; 4/4 semantic outcomes verified; old owner fenced and recipient forced to observe fresh state | 0.30 s for four parallel opens; 0.86 s wall for four intentional 0.50 s checked mutations (4.00× overlap); 1.71 s complete test |
| Calculator | Native semantic observation and acknowledged independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design; overlay acknowledged | 0.33 s including successor observation |
| Finder Downloads | Native semantic observation and acknowledged independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design; overlay acknowledged | 0.34 s including successor observation |
| Finder rename | Exact CG/AX window pairing, semantic filename discovery, generic semantic selection, one foreground attention lease, focused transient-editor HID sequence, external filesystem evaluator | Selection is AX/background-safe; commit requires foreground Return/text events | Requested successor text plus actual old/new filesystem paths | 0.21 s observation and 4.39 s checked mutation; prior 2.7 s/15 s failures are fixed |
| Calendar | Quick-event creation, parsed event discovery, and cleanup through generic semantic actions | AX creation plus foreground Return commit | Event appears outside the editor before cleanup; cleanup is checked | 0.22 s observation; included in a four-app 8.75 s parallel run |
| Calendar hidden fields | Missing URL textbox returns a structured disclosure candidate; pressing it reveals and writes `url-field` | Disclosure press and AX value write; foreground is needed only for quick-event Return commit | Exact URL value verified in the revealed field | Live regression passed 2026-08-20 |
| Notes | Create a temporary note, set its body, verify exact value, and delete it | Yes (`ax`) for create/edit/delete | Exact body value and checked absence after delete | 1.59 s cold bounded observation; 3.83 s edit/delete actions |
| Notion native app | Search-result metadata includes subrole, geometry, role description, and placeholder; exact title search resolves separately from the document body | Observation only in this regression | Distinct title/body refs on a live Notion page | Live regression passed 2026-08-20 |
| Spotify native app | Electron search textbox replacement through generic AX/PID events, result discovery outside the input, and clear | Yes (`pid`), without focus transfer | Result content for `Raga of Madness`, not merely an echoed field value | 0.19 s observation; 0.28 s checked search action |
| Spotify semantic-index torture run | Initial AX slice forced to 100 nodes; a target absent from that slice was discovered by continuation, then every live frontier was exhausted | Observation only | `search_ui` returned the target from a fresh immutable state; final index reported complete | Match at 208 indexed nodes in 0.20 s; complete at 524 nodes, 0 pending frontiers |
| App Store custom surface | Search-field value, Return submit, result discovery outside the input, and clear | AX value plus foreground Return commit | `Notion` result appears outside the search field | 0.58 s observation; included in the four-app 8.75 s parallel run |
| Managed Chromium subscription | DOM notification, conditioned long-read, authoritative successor, cursor resume, cancellation, and handoff fencing | Background CDP observation only | `Ready: changed` present in the successor AX tree | 0.72–0.74 s including an intentional 0.75 s fixture timer |
| Calculator subscription | AX notification burst coalescing and authoritative successor observation | Background AX observation only | New immutable state after semantic button press | 0.09–0.10 s event delivery and refresh |

The native concurrency run used three processes and measured 2.92× overlap.
The physical pointer moved exactly 0 px, the foreground Chrome PID/window was
unchanged, three click-through cursor overlays were acknowledged and visible, and no result
reported HID delivery, activation, or window raising. The browser run measured
2.91× parallel speedup. A same-window race completed both operations after one
worker performed an automatic local refresh and safe retry. Fifty concurrent
helper diagnostics completed in 9 ms without a connection race. A separate
single-coordinator run placed three logical
actors in one MCP process and one managed browser, measured 2.47× overlap, and
verified atomic handoff/fresh-observation fencing.

Two real Finder windows were also exercised in parallel. Their semantic reads
measured 1.58× overlap, while two process-scoped filesystem renames both
committed correctly in 8.30 s wall time. Black-box MCP cancellation and actor-
close cancellation both returned `cancelled`; the definitely-undelivered case
was safe to retry and closing the actor left zero claims.

The 50-logical-actor endurance gate ran for the full 60 minutes with one
coordinator, 50 owned browser targets, 50 durable claims, and continuous
five-second checked-mutation rounds. Every sample returned to zero active
mutations. MCP RSS peaked 39 MB above its initial sample and ended near its
starting value; file descriptors grew by at most 16. Lifecycle events remained
bounded at 4,096, the native element-ref count stayed flat at 1,657, and helper
look retention reached and remained stable at its 512-record limit.

The semantic-index torture run intentionally lowered `SCUA_AX_NODE_LIMIT` to
100. Spotify retired 184 virtualized Accessibility frontiers while the crawl
was running; SCUA counted them as stale and completed the remaining currently
accessible universe instead of aborting or silently treating a node budget as
the full tree.

## Reproduction

```sh
npm run test:logical-actors-live
npm run test:chrome-workspace-live
npm run test:multi-agent-live
npm run test:same-app-windows-live
npm run test:cancellation-live
npm run test:subscriptions-live
npm run test:real-app-mutations-live
npm run test:semantic-targets-live
npm run soak:orchestrator-live
```

The first command tests shared-process logical actors, checked browser actions,
typed ownership errors, and handoff. The second tests native overlay isolation,
frontmost-window and pointer invariants, independent-resource overlap, and a
same-resource stale write. It expects Calculator, Finder Downloads, and
Calendar windows to exist.

Observation results expose separate native timings for root resolution, AX
traversal, capture, encoding, OCR, and total time. Action execution evidence
separately reports delivery, verification, and successor-observation latency.
This keeps percentile collection mechanical without turning SQLite or a local
embedding model into the source of live element identity.

`npm run test:finder-rename-live` is an explicitly mutating, foreground-capable
external-evaluator probe. It passes only when the successor UI and the actual
filesystem agree that the old name is gone and the new name exists.
