# SCUA

SCUA is a Codex plugin for generic, semantic-first computer use. It is built as
a maintained fork of
[`injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use),
whose cross-platform state engine and native helpers remain the foundation.

Codex receives one lowest-common-denominator contract for every UI root:

```text
find roots -> observe immutable state -> query cached state -> act -> verify successor state
```

The MCP surface intentionally contains no application-specific tools and never
silently moves a task from one application to another. Desktop Accessibility
and browser CDP are internal grounding backends behind the same root, state,
element, and action model.

## Codex tools

- `actor_session`
- `claim_resource`
- `open_root`
- `find_roots`
- `observe_ui`
- `search_ui`
- `expand_ui`
- `inspect_ui`
- `act_ui`
- `execute_plan` (MCP coordinator)
- `read_text`
- `wait_for`

SCUA's launcher enables visual agent cursors and defaults to `background`
execution mode. It uses semantic Accessibility actions or process-targeted
input without activating an app when possible, then serializes a foreground
fallback only when the action genuinely requires one. `foreground` mode makes
every action visible by activating its target first. Strict `headless` mode
forbids foreground activation and physical input entirely.

Physical user input has priority over foreground automation on macOS. SCUA
waits for a configurable quiet period before taking attention, rechecks at the
native delivery boundary, and yields with a definitely-not-delivered result if
the user remains active. It never suppresses keyboard, mouse, or trackpad input;
background semantic work continues while foreground work waits.

Independent application processes and browser-page targets have separate
scheduling lanes. The macOS helper also maintains a distinct click-through
cursor overlay per active resource, so concurrent work can remain visible
without sharing one animated cursor. Foreground presentation uses one global
attention lease because an operating-system desktop can only have one
frontmost app; observation and background actions remain parallel.

External orchestrators can create up to 128 logical actors inside one MCP
coordinator. Actor identity is a coordinator-issued capability carried in MCP
request metadata, not a model-invented action field. `claim_resource` provides
durable acquire, renew, release, and atomic handoff. A handoff fences the old
owner and forces the recipient to observe a fresh state before acting.

The MCP coordinator also accepts a generic guarded action DAG through
`execute_plan`. A planner can submit independent branches once instead of
round-tripping through the model after every click. SCUA runs ready nodes in
parallel, passes successor states along declared dependencies, checks live UI
guards immediately before admitting each mutation, and refreshes only a
conflicting branch within a strict retry budget. It never retries an action
whose delivery may already have occurred. This remains a lowest-common-
denominator UI primitive rather than one tool per application.

See [SCUA architecture](docs/scua-architecture.md) for the fork-specific design
and search decisions. The concrete reliability, performance, and
orchestrator-readiness work is tracked in the [SCUA roadmap](docs/roadmap.md).
Current macOS evidence is recorded in the [compatibility matrix](docs/compatibility.md).

## Local development

```sh
npm install
npm test
./scripts/run-mcp.sh
```

The first install places a stably signed helper at
`~/Applications/pi-computer-use.app`. macOS requires Accessibility and Screen
Recording permission for that helper. The committed `.codex-plugin/plugin.json`
and `.mcp.json` make the repository directly installable as a local Codex
plugin.

## Upstream engine

<p align="center">
  <img src="./assets/logo/logo3.png" width="50%" alt="pi-computer-use">
</p>

`pi-computer-use` lets AI agents use desktop apps on macOS, Windows, and Linux.

The macOS helper requires macOS 14 or newer.

An agent can look at an app window, understand the buttons and text inside it, and perform actions like clicking, typing, scrolling, and waiting for something to change. This is useful when the agent needs to work with a normal desktop app instead of an API, a terminal command, or a file.

New to computer use? Start with: [Wait, what exactly is Computer Use?](https://zanechee.dev/what-exactly-is-computer-use/)

## What this package does

This is a Pi extension. After installation, Pi agents get tools for:

- finding open apps and windows
- observing what is visible in a window
- searching the visible interface for text, buttons, and controls
- inspecting parts of the interface in more detail
- clicking, typing, scrolling, and pressing UI controls
- waiting for UI changes

In short: it gives an agent a controlled way to operate desktop software.

## What this package is not

`pi-computer-use` is not a replacement for app APIs or MCP servers. If an app has a reliable direct integration, use that first.

Computer use is most helpful when the only available interface is the app on screen.

## Install

```bash
pi install npm:@injaneity/pi-computer-use
```

Start Pi and complete the platform setup flow.

On macOS, the helper is installed per user by default. Grant permissions to:

```text
~/Applications/pi-computer-use.app
```

Existing writable system-wide installs remain at `/Applications/pi-computer-use.app`.

Required macOS permissions:

- Accessibility
- Screen Recording, shown as Screen and System Audio Recording on newer macOS versions

The macOS setup flow registers the helper first, so it should already appear in both Settings panes. Enable the toggles and choose Recheck.

On Windows, use an interactive desktop session. Windows support uses the platform accessibility APIs and does not use the macOS helper app or TCC permission flow.

On Linux, run Pi inside the target user's graphical session with a working AT-SPI2 accessibility bus. AT-SPI semantic operations remain background-first. X11 additionally supports EWMH window metadata/focus, window capture, and policy-gated XTEST physical input; strict headless/background policies never use focus or XTEST. Native Wayland remains semantic-only; diagnostics reads portal capability properties without creating a session, and interactive portal use is disabled. See [Linux support](./docs/linux.md) for the exact capability matrix and portal status.

Use `/computer-use` inside Pi to show the active configuration and where it came from.

## Main tools

- `actor_session`
- `claim_resource`
- `open_root`
- `find_roots`
- `observe_ui`
- `search_ui`
- `expand_ui`
- `inspect_ui`
- `act_ui`
- `execute_plan` (MCP coordinator)
- `read_text`
- `wait_for`

See [docs/usage.md](./docs/usage.md) for the full tool reference.

## Documentation

- [Usage](./docs/usage.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Development](./docs/development.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Linux support](./docs/linux.md)
- [Contributing](./CONTRIBUTING.md)

## Development status

The architecture is centered on immutable, state-scoped observations. Desktop surfaces and CDP pages form one multi-root forest; progressive outline queries remain cached, while live work is ordered per physical resource so independent roots can run in parallel. `act_ui` accepts one or more intent steps, preserves focus across dependent input, verifies delivery, recovers safely, stores one complete successor state, and returns a compact diff when identity confidence allows. The MCP-only `execute_plan` composes those same generic transactions into a guarded adaptive DAG; it does not bypass `act_ui` or add application-specific behavior. Older direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` are no longer part of the public extension surface.

## License

MIT
