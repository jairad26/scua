# SCUA roadmap

SCUA is a state-scoped semantic computer runtime for macOS. An orchestrator—
Codex, an RLM, a workflow engine, or ordinary code—owns decomposition and
reasoning. SCUA owns immutable UI state, generic actions, actor identity,
resource isolation, checked mutation, cancellation, handoff, and evidence.

## Shipped foundation

- Accessibility and CDP roots use the same observe, search, act, wait, and
  verification contract; there are no application-specific public tools.
- Semantic observations are immutable and locally searchable. Large trees are
  exposed through resumable frontiers, so the first latency-bounded slice is
  not mistaken for the complete application.
- Native actions prefer background AX/PID delivery. Foreground/HID fallback is
  attention-leased, physical-user-aware, and configurable; strict headless
  mode rejects foreground evidence.
- Logical actors share one coordinator and browser pool, with bounded budgets,
  actor-scoped state, durable resource claims, atomic handoff, and old-owner
  fencing.
- Guarded action DAGs overlap independent branches, serialize conflicting
  resources, refresh only definitely-undelivered conflicts, and never replay
  possibly delivered actions.
- MCP cancellation and actor-close cancellation propagate through waits,
  actions, plans, and resource cleanup with typed delivery certainty.
- Native helper transport uses single-flight startup, bounded pre-send retry,
  concurrent request handling, and bounded look/ref retention.
- Agent cursors are independent of the physical pointer and carry a live app
  badge that follows the actor between applications.

## Release gates

These are executable product gates rather than duplicate implementation lists.

| Gate | Current evidence | Command |
|---|---|---|
| Finder mutation correctness | Distinct CG windows retain distinct AX roots; real rename verified semantically and on disk with generic `select` plus a focused transient-editor chain | `npm run test:finder-rename-live` |
| Same-app, multiple-window behavior | Finder reads overlap; process-scoped writes both commit under the shared scheduler | `npm run test:same-app-windows-live` |
| Cancellation | MCP request cancellation and actor-close cancellation are black-box verified; claims return to zero | `npm run test:cancellation-live` |
| Real-app compatibility | Notes create/edit/delete, Calendar create/verify/cleanup, and Spotify Electron search/result verification | `npm run test:real-app-mutations-live` |
| Large native trees | Initial AX walk has a 1.5-second latency budget and explicit resumable frontiers; exhaustive search remains available | `npm run test:semantic-index-live` |
| 50-actor endurance | Full 60-minute run passed with 50 managed targets and claims, continuous five-second mutation rounds, zero residual mutations, 39 MB peak RSS growth, 16 peak descriptor growth, bounded events, and helper look eviction stable at 512/512 | `npm run soak:orchestrator-live` |
| Established benchmarks | OSWorld adapter/pilot is local; MacAgentBench requires its external checkout and benchmark environment | `npm run benchmark:pilot` |

Release evidence must distinguish delivery, semantic verification, and an
external evaluator. A key event, AX value echo, changed window, or visible
cursor is not by itself proof that the requested outcome occurred.

## Active product targets

- Ordinary non-research application branches should finish in 5–10 seconds;
  cached search should remain effectively immediate.
- Background work must preserve the physical pointer, keyboard focus, and the
  user's foreground application. Foreground fallback must yield to real user
  activity and serialize through one attention lease.
- Independent resources should approach linear overlap until bounded native or
  browser capacity is reached. Same-process native writes remain conservative
  until a narrower action class is proven window-local.
- Every orchestrator-visible failure must state retryability, delivery
  certainty, resource identity, and required recovery.

## Remaining roadmap

1. [Run and publish established benchmark scores](https://github.com/jairad26/scua/issues/2)
   from provisioned OSWorld and MacAgentBench environments; do not substitute
   custom fixtures for those scores.
2. [Add durable external change-event subscriptions](https://github.com/jairad26/scua/issues/3)
   so orchestrators can await UI/resource changes without polling.
3. [Expand the compatibility matrix](https://github.com/jairad26/scua/issues/4)
   across macOS releases and more custom-rendered/Electron applications,
   preserving generic primitives and external outcome checks.
4. Bring newer generic primitives and equivalent black-box gates to Windows
   and Linux after the macOS product loop is stable.

## Non-goals

- Embedding a planner, RLM, or task-decomposition policy inside SCUA.
- Adding one public tool per application or workflow.
- Claiming universal background control where the OS or application exposes no
  reliable path.
- Using prompt discipline as a substitute for enforced ownership, fencing, or
  outcome verification.
