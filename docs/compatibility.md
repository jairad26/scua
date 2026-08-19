# macOS compatibility and latency matrix

SCUA records compatibility by generic action class, not by adding application-
specific tools. A row is evidence about an application's Accessibility or CDP
surface; it is not a permanent allowlist.

## Live baseline — 2026-08-19

| Surface | Evidence exercised | Background delivery | Verification | Observed latency |
|---|---|---|---|---|
| Managed Chromium fixture | CDP button press, textbox replacement, checkbox press, immutable successor | Yes (`cdp`) | Newly verified semantic postcondition | 0.71–0.74 s/action with an intentional 0.70 s fixture delay |
| Calculator | Native semantic observation and acknowledged independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design; overlay acknowledged | 0.33 s including successor observation |
| Finder Downloads | Native semantic observation and acknowledged independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design; overlay acknowledged | 0.34 s including successor observation |
| Calendar | Native semantic observation and acknowledged independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design; overlay acknowledged | 0.33 s including successor observation |
| Notes | Harness available; semantic create/edit compatibility must be rerun after each macOS/helper change | Not claimed by this baseline | Not claimed by this baseline | Pending |
| Spotify native app | Electron search textbox replacement through generic AX plus PID-targeted keyboard events | Yes (`pid`), without focus transfer | AX value plus resulting search content (`Raga of Madness`) | 2.2 s including fresh observations and result wait; action reported `worked` |
| Second sparse/custom app | Select in the live harness | Not claimed | Not claimed | Pending |

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

## Reproduction

```sh
npm run test:logical-actors-live
npm run test:multi-agent-live
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
