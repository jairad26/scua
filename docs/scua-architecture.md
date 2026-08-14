# SCUA architecture

SCUA preserves the upstream engine's state-scoped architecture and exposes its
generic UI contract to Codex through MCP.

## Control path

```text
Codex MCP request
  -> immutable state lookup and resource epoch check
  -> cached outline query or scheduled live operation
  -> platform-neutral action preparation
  -> macOS AX / Windows UIA / Linux AT-SPI / browser CDP backend
  -> delivery verification and one successor observation
  -> compact full view or trustworthy diff
```

An element ref belongs to one immutable `stateId`. Cached `search_ui`,
`expand_ui`, and `inspect_ui` calls do not rescan the target application.
Mutations against an old resource epoch are rejected before delivery.

## Generic tools, specialized backends

SCUA does not add tools such as `notes.create_note` or
`spotify.play_album`. Application-specific tools create an unbounded adapter
surface and hide gaps in the general interaction engine.

Backend specialization is still useful below the public contract. A desktop
window may be grounded through Accessibility while a browser-page root is
grounded through CDP, but both are observed, searched, acted on, and verified
with the same root and state model. SCUA never silently substitutes a browser
page for a native application.

## Search and embeddings

The expensive operation is obtaining a live Accessibility snapshot. Embedding
the nodes or writing them to SQLite cannot remove that cross-process traversal.
Once captured, typical UI trees are small enough that deterministic in-memory
search is cheaper than local embedding inference plus database lookup.

The hot path therefore uses:

1. one bounded native observation;
2. one complete immutable in-memory outline;
3. exact, prefix, substring, and conservative fuzzy ranking over that cache;
4. scoped expansion or a new observation only when live evidence is required.

A future local embedding model can be an optional reranker for ambiguous
natural-language queries over the current cached outline. It must not become a
source of element identity, persist actionable refs after their state expires,
or delay deterministic matches. SQLite is better suited to diagnostics and
historical performance data than to live actionable UI state.

## Attention-safe execution

The upstream engine can escalate failed background actions to foreground HID
input. SCUA adds `foreground_fallback` as a separate policy switch and disables
it in the Codex launcher. This gives SCUA a useful middle mode:

- visual, click-through agent cursor overlays are enabled;
- semantic and process-targeted background delivery are allowed;
- application activation, physical cursor movement, and global keyboard input
  are not allowed as fallback behavior.

Each macOS resource owns a separate cursor renderer and overlay window. Cursor
animation is visual evidence only and never delays or determines action
delivery.
