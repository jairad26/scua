# SCUA architecture

SCUA preserves the upstream engine's state-scoped architecture and exposes its
generic UI contract to Codex through MCP.

## Control path

```text
Codex MCP request
  -> immutable state lookup and process-shared resource lease/epoch check
  -> cached outline query or scheduled live operation
  -> platform-neutral action preparation
  -> macOS AX / Windows UIA / Linux AT-SPI / browser CDP backend
  -> delivery verification and one successor observation
  -> compact full view or trustworthy diff
```

An element ref belongs to one immutable `stateId`. Cached `search_ui`,
`expand_ui`, and `inspect_ui` calls do not rescan the target application.
Mutations against an old SCUA resource epoch are rejected before delivery,
even when competing SCUA agents run in separate MCP processes. The coordinator
uses an atomic, crash-recoverable lease per desktop application process or CDP target, so
unrelated resources can still progress concurrently. Epochs coordinate SCUA
writers; external user/app changes are detected by action postconditions and
successor observations rather than by the SCUA epoch alone.

The MCP coordinator also multiplexes logical actors. It issues authenticated
actor capabilities, scopes immutable states and browser roots to those actors,
and maintains durable resource claims across calls. Application-scoped desktop
epochs conservatively fence focus, menu, sheet, and keyboard interactions
across windows in the same process. Handoff advances a fencing generation,
revokes the prior owner, transfers browser-root discovery, and never transfers
an old `stateId`.

## Generic tools, specialized backends

SCUA does not add tools such as `notes.create_note` or
`spotify.play_album`. Application-specific tools create an unbounded adapter
surface and hide gaps in the general interaction engine.

Backend specialization is still useful below the public contract. A desktop
window may be grounded through Accessibility while a browser-page root is
grounded through CDP, but both are observed, searched, acted on, and verified
with the same root and state model. `open_root` creates a temporary,
agent-owned browser profile; it does not reuse or replace the user's normal
Chrome tabs. SCUA never silently substitutes a browser page for a native
application.

## Search and embeddings

The expensive operation is obtaining a live Accessibility snapshot. Embedding
the nodes or writing them to SQLite cannot remove that cross-process traversal.
Once captured, typical UI trees are small enough that deterministic in-memory
search is cheaper than local embedding inference plus database lookup.

The hot path therefore uses:

1. one bounded native observation;
2. one immutable in-memory outline, explicitly marked truncated when a slow AX
   server reaches its bounded node or time budget;
3. exact, prefix, substring, and conservative fuzzy ranking over that cache;
4. scoped expansion or a new observation only when live evidence is required.

A future local embedding model can be an optional reranker for ambiguous
natural-language queries over the current cached outline. It must not become a
source of element identity, persist actionable refs after their state expires,
or delay deterministic matches. SQLite is better suited to diagnostics and
historical performance data than to live actionable UI state.

## Attention-safe execution

SCUA exposes one configuration boundary with two presentation policies:

- `background` attempts semantic and process-targeted delivery first and only
  acquires foreground attention when the action requires it or a safe retry is
  justified;
- `foreground` activates the exact target before every action, while still
  preferring semantic delivery and the independent agent cursor; and
- `headless` overrides both modes and rejects foreground or physical delivery.

All foreground sections use one cross-process attention lease. This prevents
parallel workers from activating different applications between target focus
and input delivery. Independent observations, cached searches, and successful
background actions do not take that lease and continue in parallel.

Each agent/window pair owns a separate cursor renderer and overlay window.
Native overlays choose the display containing the target, remain above ordinary
application windows, and cannot receive pointer or keyboard input. CDP roots
render an equivalent cursor inside the page. Cursor animation is visual
evidence only and never delays or determines action delivery.

## Capability ladder

SCUA reports what an observation can actually support instead of turning a
successful event dispatch into a claim that the application changed:

1. semantic Accessibility/UIA/AT-SPI actions;
2. an application-exposed browser/CDP surface;
3. screenshot/OCR coordinates with a required semantic postcondition;
4. `unsupported` when the target exposes neither a controllable semantic tree
   nor a verifiable visual path.

Opaque custom applications may reject background PID events. macOS does not
provide a universal API that makes this reliable without foreground focus, so
SCUA keeps foreground fallback disabled and reports that boundary honestly.

## MCP response boundary

The complete cached outline and screenshots remain inside the SCUA process.
MCP `structuredContent` contains continuation identifiers, bounded matches,
execution evidence, and capability counts, but omits duplicate outline and
image payloads. This prevents a single large application from consuming
hundreds of thousands of model tokens while preserving cached search and
scoped expansion.

Failures use a typed envelope with a stable code, actor and resource identity,
epoch facts when applicable, retryability, delivery certainty, and one required
recovery action. Operation lifecycle events record actor, tool, resource,
epoch, state, outcome, cancellation, and handoff facts for bounded trace
reconstruction.

## Roadmap

SCUA is intended to remain model- and orchestrator-agnostic while becoming safe
to drive from a dynamic multi-actor control plane. Confirmed gaps, prioritized
fixes, and the fifty-actor acceptance gate are maintained in the
[SCUA roadmap](roadmap.md).
