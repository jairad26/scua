# macOS compatibility and latency matrix

SCUA records compatibility by generic action class, not by adding application-
specific tools. A row is evidence about an application's Accessibility or CDP
surface; it is not a permanent allowlist.

## Live baseline — 2026-08-18

| Surface | Evidence exercised | Background delivery | Verification | Observed latency |
|---|---|---|---|---|
| Managed Chromium fixture | CDP button press, textbox replacement, checkbox press, immutable successor | Yes (`cdp`) | Newly verified semantic postcondition | 0.71–0.74 s/action with an intentional 0.70 s fixture delay |
| Calculator | Native semantic observation and independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design | 2.63 s including successor observation |
| Finder Downloads | Native semantic observation and independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design | 2.79 s including successor observation |
| Calendar | Native semantic observation and independent agent-cursor move | Yes (`pid`), no HID/activation | `unknown` for visual-only cursor movement by design | 2.81 s including successor observation |
| Notes | Harness available; semantic create/edit compatibility must be rerun after each macOS/helper change | Not claimed by this baseline | Not claimed by this baseline | Pending |
| Spotify native app | Known sparse/custom surface; rerun the harness before claiming control | Unsupported unless a verifiable generic path is exposed | Must fail honestly rather than substitute a web app | Pending |
| Second sparse/custom app | Select in the live harness | Not claimed | Not claimed | Pending |

The native concurrency run used three processes and measured 2.93× overlap.
The physical pointer moved exactly 0 px, the foreground ChatGPT PID/window was
unchanged, three click-through cursor overlays were visible, and no result
reported HID delivery, activation, or window raising. The browser run measured
2.91× parallel speedup. A separate single-coordinator run placed three logical
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
