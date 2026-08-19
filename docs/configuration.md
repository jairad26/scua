# Configuration

Configuration controls browser access, execution presentation, strict accessibility execution, and the macOS agent cursor.

## Files

Global config:

```text
~/.pi/agent/extensions/pi-computer-use.json
```

Project config:

```text
.pi/computer-use.json
```

Project config overrides global config. Environment variables override both.

Example:

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "execution_mode": "background",
  "user_quiet_period_ms": 750,
  "user_activity_timeout_ms": 5000
}
```

Run `/computer-use` in Pi to show the active config and its source.

## Options

### `browser_use`

Default: `true`

When `false`, the extension refuses known browser windows. This is useful for projects that should not control browsers.

Known browser families include Safari, Chrome and Chromium-family browsers, Firefox, Arc, Brave, Edge, Vivaldi, and Helium.

### `managed_browser`

Default: `"chrome"`

Selects `"helium"` or `"chrome"` for `launch_browser`. The debugging port is always allocated internally and isn't part of the model-facing contract.

### `headless`

Default: `false`

When `true`, actions must remain in the background. Raw pointer events, raw keyboard events, foreground focus fallback, cursor takeover, and the agent cursor overlay are blocked. This strict policy overrides `execution_mode`.

### `execution_mode`

Default: `"background"`

`"background"` keeps independent application lanes concurrent and uses semantic Accessibility or process-targeted delivery without activating the target when possible. If an action explicitly requires foreground input, or a side-effect-free background attempt is conclusively unsuccessful, SCUA acquires the global attention lease, activates the exact target, and retries safely.

`"foreground"` activates the exact target before each action so the work is visible. Semantic actions still use Accessibility and the independent agent cursor when possible; physical delivery remains a last resort. Because a desktop has only one frontmost application, foreground delivery sections are serialized while observation, cached search, and background work remain concurrent.

### `cursor_overlay`

Default: `true`

When `true`, macOS pointer actions enqueue a click-through agent cursor animation to the native grounded point during non-headless background delivery. Foreground actions that control the physical cursor don't display the overlay. The overlay doesn't move the system pointer, accept input, or delay the action. Set it to `false` for invisible automation. `headless: true` always suppresses it regardless of this setting.

### `user_quiet_period_ms`

Default: `750`

Before activating an application or delivering global HID input on macOS, SCUA
waits until physical keyboard, mouse, scroll, and trackpad input has been quiet
for this continuous interval. It checks once before requesting the global
attention lease, again after acquiring it, and again inside the native helper
before activation or HID delivery. Background Accessibility, process-targeted,
and CDP work is not delayed. Set this to `0` only to disable physical-user
priority explicitly.

The helper prefers a passive listen-only Quartz event tap and tags its own
synthetic input so it is not mistaken for user activity. The tap never modifies
or discards events. If macOS does not permit passive monitoring, SCUA falls back
to the hardware event-state timer. Enabling **Input Monitoring** for the helper
improves synthetic-event discrimination but is not required for the fallback.

### `user_activity_timeout_ms`

Default: `5000`

Maximum time one foreground section yields while the user remains active. If
the budget expires, SCUA returns the typed `user_active` error with
`definitely_not_delivered` delivery evidence and `reacquire` recovery guidance.
Independent background work continues throughout the wait.

## Environment variables

```bash
PI_COMPUTER_USE_BROWSER_USE=0
PI_COMPUTER_USE_BROWSER_USE=1
PI_COMPUTER_USE_MANAGED_BROWSER=helium
PI_COMPUTER_USE_MANAGED_BROWSER=chrome
PI_COMPUTER_USE_CHROME_EXECUTABLE=/absolute/path/to/chrome
PI_COMPUTER_USE_HELIUM_EXECUTABLE=/absolute/path/to/helium
PI_COMPUTER_USE_HEADLESS=0
PI_COMPUTER_USE_HEADLESS=1
PI_COMPUTER_USE_CURSOR_OVERLAY=0
PI_COMPUTER_USE_CURSOR_OVERLAY=1
PI_COMPUTER_USE_EXECUTION_MODE=background
PI_COMPUTER_USE_EXECUTION_MODE=foreground
PI_COMPUTER_USE_USER_QUIET_PERIOD_MS=750
PI_COMPUTER_USE_USER_ACTIVITY_TIMEOUT_MS=5000
PI_COMPUTER_USE_DELIVERY_POLICY=default
PI_COMPUTER_USE_DELIVERY_POLICY=foreground
PI_COMPUTER_USE_CDP_PORT=9222
```

`PI_COMPUTER_USE_HEADLESS=1` prohibits foreground fallback. `PI_COMPUTER_USE_DELIVERY_POLICY` is a low-level debugging input; normal policy belongs in `execution_mode` rather than individual model calls.

`launch_browser` searches common platform install locations and `PATH`. Use `PI_COMPUTER_USE_CHROME_EXECUTABLE` or `PI_COMPUTER_USE_HELIUM_EXECUTABLE` for an AppImage, portable install, or any non-standard location. An explicit override is authoritative and must name an executable file.

## CDP browser support

`PI_COMPUTER_USE_CDP_PORT` enables Chrome DevTools Protocol support for Chromium-family browsers. Launch the browser with `--remote-debugging-port=<port>` and set this variable to the same port.

Use a dedicated, non-default profile with `--user-data-dir=<directory>`. Chrome 136 and later ignore remote-debugging switches for the default data directory as a security measure. `launch_browser` already creates a temporary, separate CDP profile and binds discovery to a randomly allocated loopback port.

When CDP is active, discovered pages participate in the same root and state system as desktop UI. `launch_browser` configures CDP automatically and returns an observed page state. `navigate_browser` and `evaluate_browser` accept only CDP browser-page states; native browser windows continue to use the normal desktop observe/act tools.

With the variable unset, CDP is inactive.
