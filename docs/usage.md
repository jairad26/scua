# Usage

The normal loop is:

1. Find a desktop or browser root.
2. Observe that root and retain its `stateId`.
3. Search, expand, or inspect that immutable state.
4. Act using the same `stateId` and its `@e` refs.

## Tools

| Tool | Purpose |
| --- | --- |
| `find_roots` | Return a bounded, ranked set of desktop and CDP browser-page roots. |
| `observe_ui` | Capture the current/frontmost root or one exact `@r` root and return a folded outline plus `stateId`. |
| `search_ui` | Run a bounded, ranked query over the full cached outline. |
| `expand_ui` | Show local outline context for one ref. |
| `inspect_ui` | Show fields, rects, actions, and evidence for one ref. |
| `act_ui` | Perform checked actions and return the resulting saved state, showing its changes or a full view when needed. |
| `execute_plan` | MCP-only: execute a guarded dependency DAG of ordinary `act_ui` transactions with bounded parallelism and localized recovery. |
| `read_text` | Read fixed pages from state-owned `@e` text or immutable `@o` output. |
| `wait_for` | Wait for a precise, optionally scoped condition. |
| `subscribe_ui` | Create an actor-owned native/browser change stream from an immutable state. |
| `read_ui_events` | Long-read bounded events from an opaque cursor and return an authoritative successor state. |
| `unsubscribe_ui` | Close a subscription and stop its event pump. |
| `launch_browser` | Open an inactive owned tab in the SCUA Chrome group (or isolated fallback browser) and return its observed page state. |
| `navigate_browser` | Navigate the browser page owned by a state. |
| `evaluate_browser` | Evaluate JavaScript in the browser page owned by a state. |

## Refs and state

`find_roots` returns roots such as `@r1`. Every desktop window, transient surface, and CDP page participates in that same forest. `observe_ui` returns element refs such as `@e12` and a `stateId`.

Every tool that consumes an `@e` ref also requires its owning `stateId`. A state remains queryable while it is in the bounded store, but a mutation from an old resource epoch is rejected as stale. `act_ui` returns the next usable `stateId`; consume it directly instead of observing again. Observe again only after an uncertain external mutation or state eviction.

Truncated textual output receives an immutable session-local ref such as `@o1`. Continue it with `read_text({ ref: "@o1", offset })`; output refs don't use a UI state id. Tool-provided `@o` offsets are UTF-8 byte offsets, while `@e` text offsets count Unicode characters.

Nodes marked `pictureOnly` have visual evidence but no platform accessibility element. Semantic actions cannot target them. Coordinate actions are available only from a current image-bearing desktop state.

## Progressive disclosure

Use `observe_ui({ root: "@r1" })` for the compact first view. Then query without another capture:

```ts
search_ui({ stateId, text: "Save" })
expand_ui({ stateId, ref: "@e7", depth: 3 })
inspect_ui({ stateId, ref: "@e12" })
```

`semantic` observation is cheapest, `fused` is the default, and `visual` forces visual text evidence. Search requires at least one of `text`, `role`, or `capability`. It ranks exact, prefix, and substring text before conservative fuzzy matches, returns a fixed top set with the total match count, and asks the caller to refine broad queries. Each returned match includes normalized `capabilities` such as `press`, `focus`, `setValue`, `scroll`, and `textInput`; use these instead of inferring editability from application-specific labels or raw AX action names. Search can escalate OCR once when the original desktop look omitted it; that refresh is checked against the state's resource epoch.

Postconditions accept exact empty-string values, which is useful for reversible
compatibility probes and cleanup. When Electron or another virtualized surface
replaces a live control after delivery, SCUA rebinds the expected ref against
the authoritative successor state before deciding whether the condition
passed. It does not replay an action that may already have been delivered.

On macOS, a large Accessibility tree is returned quickly as an initial slice and
then exhausted through background continuations. A cache-miss search waits up
to the configured latency window for matching nodes and returns
`details.semanticIndex` with `complete`, `indexedNodes`, `pendingFrontiers`,
`revision`, `staleFrontiers`, and an optional `error`. If the search adopts a
newer index revision, its returned `stateId` is the one to use for later
inspection or action. There is no total semantic node cap; the native per-slice
budget only prevents one traversal from monopolizing the helper.

## Durable change subscriptions

Use subscriptions when an external orchestrator needs to react to future UI
changes without repeatedly calling `observe_ui`:

```ts
const subscription = subscribe_ui({
  stateId,
  scopeRef: "@e12",
  text: "Complete",
  until: "present"
})

const next = read_ui_events({
  subscriptionId: subscription.subscriptionId,
  cursor: subscription.cursor,
  timeoutMs: 60_000
})
```

`subscribe_ui` acquires or renews the actor's resource claim. Native macOS
subscriptions are woken by `AXObserver`; managed browser subscriptions are
woken by a page-local `MutationObserver`. These notifications are hints, not
state: `read_ui_events` performs an authoritative semantic observation before
returning a changed `stateId`. A conditioned read continues through unrelated
notifications until its condition is established, the stream terminates, or
the deadline expires.

Always pass `nextCursor` to the next read. Cursors are opaque, actor-scoped,
and safe to resume across individual MCP calls or transport reconnects while
the coordinator process and actor session remain alive. Every retained event
includes `subscriptionId`, `actorId`, `resourceKey`, `resourceEpoch`, and a
stable `traceId` for delivery-safe deduplication. The stream retains at most
256 events and terminal records expire after five inactive minutes; a lagging
cursor receives an explicit `overflow` event and authoritative refresh.
Cancellation, release, handoff, actor close, and source failure stop the pump;
old ownership is never silently transferred. Use `unsubscribe_ui` when the
stream is no longer needed.

## Acting and batching

The public action shape is always transactional:

```ts
act_ui({ stateId, actions: [{ action: "press", ref: "@e12" }] })
```

When an action has an observable completion signal, attach it to the same
transaction. Pi waits through the platform change-notification path and marks
the execution `didnt` with `postcondition_failed` if the application swallowed
the delivered event:

```js
act_ui({
  stateId,
  actions: [{ action: "press", ref: "@e12" }],
  expect: { text: "Archive completed", until: "present", timeoutMs: 3000 }
})
```

Verification reports `verified`, `preexisting`, or `failed`. A preexisting
condition means the requested end state holds, but is not evidence that the
action caused it. Use `ref` for one exact element or `scopeRef` for a subtree;
role-only conditions must be scoped, and value checks require an exact `ref`.

Batch steps only when the second step does not need to inspect the result of the first:

```ts
act_ui({
  stateId,
  actions: [
    { action: "setText", ref: "@e18", text: "hello" },
    { action: "press", ref: "@e22" },
  ],
})
```

Steps run sequentially against one resource and retain helper checks. The native helper uses one root baseline and final settle for the transaction, and the bridge returns one final observation. If a transition can change the meaning of later refs or requires a decision, send one action, inspect the returned state, then continue.

The generic action vocabulary is `press`, `click`, `select`, `setText`,
`typeText`, `keypress`, `scroll`, `drag`, `moveMouse`, and `wait`. `select`
sets the nearest semantically selectable ancestor and preserves focus for a
following keyboard step. `wait` is a focus-preserving delay inside the current
transaction; it is useful for short native transitions such as an inline
editor appearing, but it is not a substitute for an observable `expect` or a
new observation when later actions depend on changed UI meaning.

Any ref-targeted action can instead use a semantic selector. SCUA resolves it
against the exact immutable state being acted on and fails before delivery if
the best target remains ambiguous:

```ts
{ action: "setText", selector: { text: "page title", role: "textbox", capability: "setValue" }, text: "Draft" }
```

Clicks into editable regions establish foreground focus for later keyboard steps in the same transaction. Omit `ref` from `typeText` or `keypress` after such a click so input is sent to the editor established by that click:

```ts
act_ui({
  stateId,
  actions: [
    { action: "click", x: 420, y: 300 },
    { action: "typeText", text: "hello" },
  ],
  expect: { text: "hello" },
})
```

The runtime prefers background semantics when they are credible, verifies the result, and escalates side-effect-free failed keyboard input to foreground delivery automatically. Ambiguous pointer actions are never replayed blindly.

### Adaptive action plans

An external orchestrator can avoid one model round trip per action by sending a
small dependency graph to the MCP coordinator. Every node still uses the
ordinary generic action and condition contracts:

```ts
execute_plan({
  planId: "prepare-and-send",
  maxConcurrency: 4,
  nodes: [
    {
      id: "draft-note",
      stateId: notesState,
      guards: [{ ref: "@e12", role: "textbox" }],
      actions: [{ action: "setText", ref: "@e12", text: "Draft" }],
      expect: { ref: "@e12", value: "Draft" }
    },
    {
      id: "prepare-message",
      stateId: slackState,
      guards: [{ ref: "@e7", role: "textbox" }],
      actions: [{ action: "setText", ref: "@e7", text: "Ready" }],
      expect: { ref: "@e7", value: "Ready" }
    },
    {
      id: "save-note",
      dependsOn: ["draft-note"],
      stateFrom: "draft-note",
      guards: [{ ref: "@e18", text: "Save" }],
      actions: [{ action: "press", ref: "@e18" }],
      expect: { text: "Saved" }
    }
  ]
})
```

Ready nodes on independent resource lanes overlap. `stateFrom` consumes the
successful predecessor's immutable successor state. Every node must provide at
least one explicit guard that was true in its base state, or use semantic
selectors for all targets. Selectors are resolved at node execution time and
the native boundary checks their captured identity. SCUA checks explicit guards
again while holding the resource lease and before advancing its epoch. If the user,
application, or another actor changed the relevant UI, no action is admitted.
Only that definitely-undelivered node may re-observe and retry, at most twice
by default and within 2.5 seconds. Failed descendants are blocked, unrelated
branches continue, and any uncertain delivery fails closed without replay.
Plan nodes default `skipIfExpected` to true, preventing idempotent setup actions
from creating duplicate UI when their postcondition already holds.

Plans are limited to 64 nodes and 32 concurrently running nodes. They are an
MCP orchestration primitive, so the direct Pi extension surface remains the
smaller observe/query/`act_ui` loop.

### Successor views

The initial `observe_ui` response is a full folded view. A normal `act_ui` response saves the complete resulting state but renders only its trustworthy changes:

```text
Successor diff (1 change, S1 → S2):
~ @e9 (@e1 > @e9) value="hello"
Use stateId S2 for subsequent actions and queries.
```

Confidently matched elements retain their model-facing refs across resulting states. New nodes receive new refs and removed nodes are named explicitly. The runtime returns a full folded view instead when the root was replaced, identity confidence is low, or the change budget is too large. `search_ui`, `expand_ui`, and `inspect_ui` always query the complete saved state regardless of how it was rendered.

Coordinate fallback uses image pixels from the observed state:

```ts
act_ui({ stateId, actions: [{ action: "click", x: 420, y: 300 }] })
```

## Bounded output

Every model-visible textual result is limited to 48 KiB or 2,000 lines. Oversized results return a 16 KiB preview, focused-query guidance, and an immutable `@o` continuation. Discovery tools don't page through irrelevant matches: refine `find_roots` and `search_ui` instead. Continuation is intended for concrete long text, evaluation values, and diagnostics.

## Browser use

Browser-specific commands operate only on browser-page states. With the SCUA
Chrome companion installed, `launch_browser` creates an inactive tab in the
current process's `SCUA` group inside the existing focused Chrome window. It
does not select the tab or enumerate unrelated tabs. Without the companion it
chooses the configured isolated browser and debugging port internally. Both
paths immediately return an observed state:

```ts
const launched = launch_browser({ url: "https://example.com" })
act_ui({ stateId: launched.stateId, actions: [{ action: "press", ref: "@e7" }] })
navigate_browser({ stateId: returnedStateId, url: "https://openai.com" })
evaluate_browser({ stateId: returnedStateId, expression: "document.title" })
```

Browser states use the same outline, action, text, and condition contracts as desktop states. Native browser windows remain ordinary desktop UI; use `observe_ui` and `act_ui` rather than `navigate_browser` or `evaluate_browser` on them.

The returned `root.transport` is `chrome_extension` or `direct_cdp`. Extension
roots also include `root.workspace` with the workspace, group, and window IDs
plus whether Chrome reused an existing window and whether the new tab became
active. Those fields are execution evidence, not action inputs.

## Parallel calls

Pi may issue tool calls concurrently. Cached queries can overlap freely. Live work for different desktop processes or CDP pages can overlap; work for the same physical resource is ordered. Do not intentionally race two mutations derived from the same state: one wins and the other receives a stale-state error by design.
