# SCUA roadmap

SCUA's near-term objective is dependable, non-interfering computer control on
macOS. Its longer-term API objective is to be an orchestrator-native semantic
computer runtime: an external program should be able to coordinate many
logical actors without SCUA depending on prompt discipline, a specific model,
or application-specific public tools.

The orchestration layer may be Codex, an RLM, a workflow engine, or ordinary
code. SCUA owns computer state, actor identity, resource isolation, checked
mutation, and evidence. It does not own task decomposition or model recursion.

## Implementation snapshot — 2026-08-19

The concrete engine work in this roadmap is now implemented:

- browser search is backend-isolated and cannot enter desktop OCR;
- browser mutations return the same execution/outcome/verification shape as
  native mutations, including pre-existing and failed postconditions;
- desktop states and mutations use conservative application-process epochs,
  so focus/menu/sheet/keyboard effects fence every window in the app;
- foreground fallback is attention-leased and configurable, while strict
  headless mode rejects returned HID/activation/raise evidence as a runtime
  invariant;
- macOS physical-user activity has priority over foreground work through a
  passive, synthetic-event-aware quiet-period monitor with native pre-delivery
  rechecks and bounded yielding;
- automatic desktop observation is semantic-first, with visual/OCR escalation
  only for explicit, sparse, or unlabeled roots;
- CDP connections persist, waits use mutation notification plus a bounded
  authoritative fallback, and final states remain immutable;
- MCP exposes typed errors with delivery certainty and recovery guidance;
- one coordinator multiplexes authenticated logical actors through request
  metadata, actor-scoped state/root retention, one browser pool, bounded action
  and time budgets, and bounded lifecycle traces;
- durable acquire/renew/release and atomic handoff fence old owners, reject
  in-flight handoff, transfer browser-root discovery, and require a fresh
  recipient observation;
- scheduler owners carry a process-start token, ownerless locks self-repair,
  and old epoch/temp metadata has a bounded garbage collector;
- MCP accepts a generic guarded action DAG: independent branches overlap,
  successor states flow through dependencies, live guard checks happen under
  the resource lease before epoch advance, and bounded refresh/retry is local
  to a definitely-undelivered conflicting branch; and
- uncertain or possibly delivered actions are never automatically replayed,
  while failure blocks only dependent nodes and leaves unrelated work running.

Automated coverage includes 50 logical actors making concurrent progress in
one coordinator process, same-app mutation serialization with window-local
read overlap, cross-app overlap, explicit plan cancellation, actor-close
cancellation, typed stale/ownership errors, CDP false-delivery and
page-exception handling, actor state isolation, and handoff fencing. A
configurable one-hour soak harness now measures progress, retained events,
heap, and file descriptors; the five-second smoke completed 4,550 operations
with peak concurrency 50 and no observed heap or descriptor growth. The full
one-hour run and broader real-app rows remain operational release gates.

## Current evidence

The live three-agent fixture has established a useful baseline:

- three independent browser actions completed in about 0.79 seconds of wall
  time versus about 2.39 seconds sequentially (3.01x measured speedup);
- three native cursor overlays existed concurrently across Calculator, Finder,
  and Calendar while ChatGPT retained focus;
- two MCP processes racing the same Calculator state produced one winner and
  one stale-state rejection; and
- cached outline queries, process-shared resource epochs, compact MCP output,
  and foreground-fallback-disabled launch policy are implemented and covered
  by tests.

This proves useful concurrency across different processes and a fail-closed
same-resource race. Unit/integration evidence also covers same-application
claim scope, 50 logical actors, cancellation, and explicit handoff. Live
same-app multi-window behavior, a one-hour sustained run, and broad background
compatibility across opaque applications still need operational evidence.

## Open empirical issues — 2026-08-19

- Finder can accept a filename `AXValue` and expose the requested name without
  committing it to the filesystem. SCUA no longer treats a key event plus a
  window change as semantic success, and benchmark success claims now fail
  closed on unknown or unresolved mutations. The generic foreground rename
  composition is retained as a gated external-evaluator probe, but Finder
  commit remains unsupported rather than falsely reported as complete.
- Finder focus-chain profiling removed unnecessary screenshot hydration and
  now holds one attention lease without refocusing between dependent keys.
  The remaining direct probe is executor/application behavior, not planner
  overhead.
- The MacAgentBench adapter is implemented, but this machine does not have a
  MacAgentBench checkout or provisioned macOS benchmark VM. No established
  benchmark score is claimed until that external environment exists.

## Immediate correctness work

### P0: keep browser search inside its backend

`search_ui` can escalate a browser state's static or empty result into the
desktop OCR path. The live harness exposed this as `No current controlled
window. Call observe_ui first.` Browser-page states must never call desktop
capture or OCR. Any future browser visual escalation must remain target-scoped
and use the same browser resource epoch.

Acceptance:

- empty, static-text-only, actionable, and role-only searches on browser states
  never resolve a desktop target;
- the returned `stateId` remains owned by the same CDP target; and
- a regression test reproduces the former static-result failure.

### P0: make browser outcomes as honest as native outcomes

CDP event dispatch currently returns a refreshed browser state but not the
native path's structured execution record (`worked`, `didnt`, or `unknown`). A
non-visual browser action can also use an already-satisfied expectation without
clearly reporting it as pre-existing. Event delivery alone must not imply that
the intended state change occurred.

Acceptance:

- every browser mutation returns delivery, verification status, outcome,
  evidence, base state, and successor state;
- expectations are classified as `verified`, `preexisting`, or `failed` for
  both semantic and coordinate actions;
- a pre-existing expectation cannot upgrade an unknown delivery to `worked`;
  and
- browser and native action results share one platform-neutral schema.

### P0: coordinate desktop resources at the correct scope

The current desktop resource key contains a window identity, while focus,
menus, sheets, and keyboard state can cross windows within one application.
The existing live test used three different application processes, so it did
not validate same-app, different-window concurrency.

Implement hierarchical resource claims: application-scoped claims for actions
that can affect focus, menus, sheets, or keyboard state; window-scoped claims
only for operations proven local to one root. Prefer conservative
serialization until an action class is proven window-local.

Acceptance:

- two-window tests cover semantic reads, independent value writes, menus,
  sheets, and focused text input in one application;
- potentially focus-changing operations cannot overlap within one app; and
- independent operations in different apps continue to overlap.

### P0: preserve the configured attention boundary

The Codex launcher defaults to background-first execution, while explicit
foreground mode presents every action. Keep both policies enforced by runtime
configuration and a global foreground attention lease rather than prompt
convention.

Acceptance:

- background-mode integration tests prove that independent semantic actions
  overlap and only required fallback sections activate an app;
- foreground-mode integration tests prove that the exact target is activated
  before delivery and competing workers cannot fight for focus;
- agent cursor overlays remain click-through and never become key/main; and
- headless mode rejects any HID delivery or application activation.

## Performance work

### P1: make automatic observation genuinely semantic-first

Default `auto` observation and desktop successor capture currently request a
window image before deciding whether the Accessibility outline is sufficient.
That pays ScreenCaptureKit and JPEG costs on many semantic-only paths. Use a
two-stage policy: capture the bounded semantic outline first, then request an
image/OCR only when explicit visual mode, sparse/unlabeled structure, or a
coordinate action requires it.

Acceptance:

- dense semantic observations and semantic action successors perform no screen
  capture or image encoding;
- sparse and visual roots still escalate with an explicit reason;
- native timings report root resolution, AX traversal, capture, encoding, OCR,
  action delivery, verification, and successor observation separately; and
- benchmarks report cold observation, cached query, semantic action, visual
  action, and postcondition latency independently.

### P1: avoid full browser snapshots while waiting

Browser postcondition polling can repeatedly fetch the complete CDP
Accessibility tree. Prefer a persistent target connection plus change
notification or a narrowly evaluated condition, followed by one authoritative
successor snapshot.

Acceptance:

- one browser action opens no more than one target connection in the normal
  path;
- waiting does not fetch the complete accessibility tree every 100 ms; and
- the final result still owns one immutable authoritative successor state.

### P1: measure real applications, not only deterministic fixtures

Maintain a macOS compatibility and latency matrix for Notes, Finder, Calendar,
Calculator, Chrome, and at least two sparse/custom-rendered applications. Record
semantic coverage, background delivery support, verification quality, and
latency percentiles. Sparse Accessibility support (for example, an opaque
Spotify surface) is an operating-system/application capability boundary, not a
reason to add an app-specific public tool or silently switch applications.

## Orchestrator-native control plane

### P1: multiplex logical actors through one coordinator

`SCUA_AGENT_ID` is currently fixed per MCP process. Dynamic orchestration should
not require one operating-system process—or one Chrome process—per logical
actor. Introduce coordinator-issued actor/session identities carried by the
connection or authenticated request context. Do not accept arbitrary
model-supplied actor IDs on individual action payloads.

Each actor receives scoped access to roots and state, while the shared
coordinator owns scheduling, browser pools, epochs, and traces.

### P1: expose explicit ownership and handoff

The current lease protects one live operation and epochs reject stale writes,
but there is no durable orchestrator-facing ownership or handoff contract.
Add scoped acquire, renew, release, and atomic handoff operations. The previous
owner must be unable to mutate after handoff without reauthorization and a
fresh observation.

This is generic concurrency control, not RLM-specific behavior. Task planning,
spawning, joining, and recursive decomposition remain above SCUA.

### P1: execute adaptive action DAGs

Implemented in the MCP coordinator. `execute_plan` accepts up to 64 generic
action nodes with dependencies, immutable state inputs, required live guards,
postconditions, bounded concurrency, and bounded refresh policy. It reuses
`act_ui`; it does not create application-specific shortcuts or a second action
engine.

Remaining acceptance work is empirical: benchmark complete real-application
plans and keep ordinary non-research branches within the 5–10 second product
target. The native physical-user quiet-period signal is implemented: it
distinguishes tagged SCUA input from actual user input, waits outside all
resource leases, rechecks immediately before foreground/HID delivery, and
fails definitely-not-delivered if the user remains active.

### P1: return typed errors and retry guidance

MCP currently reduces failures to `isError` plus text; the live harness had to
recognize stale state with `/stale/i`. Return a platform-neutral error envelope
containing at least:

- stable code;
- resource identity;
- actor/session identity;
- expected and actual epoch when applicable;
- retryability;
- whether delivery may have occurred; and
- required recovery (`reobserve`, `reacquire`, `unsupported`, or `abort`).

### P1: make state retention actor-aware and bounded globally

The current saved-state store retains 32 observations per MCP process and the
native helper retains eight looks. Replace process-local assumptions with
actor-aware quotas, explicit expiry, and a global memory bound. A handoff must
never transfer a raw state reference implicitly; the recipient acquires the
resource and observes a fresh state.

### P2: durable events, cancellation, budgets, and traces — partially complete

Operation lifecycle records, prompt cancellation, action/time budgets, bounded
traces, standard MCP request cancellation, actor-close cancellation, and
per-node delivery certainty are implemented. A durable external change-event
subscription that lets an orchestrator wait without polling remains open.

Garbage-collect coordinator epoch/lease metadata. Lease ownership must include
a process-start identity or equivalent fencing token so PID reuse cannot make a
dead owner look alive.

## Fifty-actor acceptance gate

SCUA is orchestrator-ready when one external program can dynamically operate 50
logical actors while satisfying all of the following:

1. Actor creation does not create 50 MCP or Chrome operating-system processes.
2. Independent resources make measurable concurrent progress with bounded
   coordinator overhead.
3. Conflicting writes produce deterministic typed results; no two writers
   believe they committed the same resource epoch.
4. Atomic handoff revokes the old owner and enables the new owner after a fresh
   observation.
5. Cancellation and actor failure release or fence resources without waiting
   for a global timeout.
6. The physical pointer, global keyboard focus, and user's foreground
   application remain unchanged in background mode.
7. Memory, file descriptors, browser targets, helper look records, and
   coordinator metadata remain within explicit bounds during a one-hour soak.

Run the operational gate with `npm run soak:control-plane`. Use
`node scripts/soak-control-plane.mjs --duration-ms 5000` only as a smoke check;
it is not a substitute for the one-hour acceptance run.
8. The complete actor/resource/action trace can be reconstructed without
   scraping human-readable text.
9. The same public contract controls Accessibility and CDP roots without
   application-specific agent tools.
10. A single-agent run remains simpler and no slower in a meaningful way; the
    control plane does not force recursive or multi-agent execution.

## Non-goals

- Embedding a planner, RLM, or task-decomposition policy inside SCUA.
- Adding one public tool per application or workflow.
- Claiming universal background control where macOS or an application exposes
  no reliable, verifiable path.
- Allowing prompt instructions to substitute for enforced resource ownership
  or capability restrictions.
