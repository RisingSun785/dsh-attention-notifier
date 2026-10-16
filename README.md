# Attention Notifier

[简体中文](README.zh-CN.md) | **English**

Tells you when DeepSeek Harness needs you — or when a task has finished — especially
while the window is minimised and you are doing something else.

Built for the one problem that makes a long-running agent wasteful: you minimise DSH,
the agent stops to ask for a permission decision, and nothing tells you. Minutes pass.
The same happens when a task completes while you are away.

## What it notifies on

| Moment | Source | Default | Notes |
|---|---|---|---|
| **Waiting for permission** | `approval/request` waterfall | Always | A tool asks to run. **Blocking**: the agent cannot continue until you answer |
| **Waiting for an answer** | `user-questions/request` waterfall | Always | `ask_user_question`, including plan-mode reviews. Also blocking |
| **Task finished** | `session/event` `turn/end` (`agent/status → idle` is a secondary signal) | Only when unfocused | One turn completed. Subject to the minimum-duration threshold |
| **Task failed** | `agent/error` | Always | The turn ended in error. **A manual stop does not count** — abort goes through `turn/end{aborted}` and is mutually exclusive with error |

> **If the plugin loads while an agent is already running**, that turn may deliver no
> `agent/status` event at all — the event is only dispatched when the status *string*
> changes. Completion therefore keys off `turn/end`, which also carries `reason.kind`
> so `completed` / `aborted` / `interrupted` can be told apart.

## Channels

| Channel | How | Reaches a minimised window? |
|---|---|---|
| **Windows notification** | `powershell.exe` 5.1 → WinRT toast, AppId `com.deepseek.dsh`, **with an "Open DSH" button** | Yes — and the button restores the window |
| **Sound** | Carried by the toast's own `<audio>` element (`ms-winsoundevent:Notification.Default`) | Yes |
| **In-app notice** | Client plugin registered into `shell.overlay`, a floating card in the top-right | Needs a visible window |

### Bringing the user back from a minimised window

This is the design's central point: **while the window is minimised, nothing inside the
application is visible.** So:

1. **The system notification appears over whatever you are using** and plays a sound —
   the only channel that works while minimised;
2. **It carries an "Open DSH" button** that activates the `dsh://open` protocol. DSH's
   `open-url` handler calls `focusPrimaryWindow()` (restore → show → focus), bringing the
   window back. The protocol is registered by the installer, and both the button's XML
   shape and the activation path were verified on a real machine.

**That is why the in-app notice has no "Open DSH" button** — it is only visible when the
window is already in front, so that button would be a no-op. The notice's value is
showing the pending content **in full** (system notifications get truncated).

> Setting `restoreOnClick` to `false` removes the button, at the cost of the user having
> to switch back to the window themselves.

> **No taskbar-flash channel.** The only mechanism a plugin can reach is prefixing the web
> page's title, and this application's window has no visible title bar, so the marker is
> never rendered where a user could see it. Electron's real `win.flashFrame` needs the
> window handle, which the Host half cannot obtain. **A switch that cannot visibly do
> anything is worse than no switch**, so the channel was removed rather than kept.

Each moment takes its own policy: **off / only when unfocused / always**.

### What each channel switch actually governs

| Switch | Where it acts | When off |
|---|---|---|
| `channels.toast` | **Host** calls WinRT | No system notification (falls back to sound alone) |
| `channels.sound` | Sent as the toast's `<audio>` | Silent notification |
| `channels.inApp` | **Host**'s page message queue | Nothing is queued or sent to the page → no notice |

> Every switch must be consumed **on the Host side**. Hiding UI in the front end is not
> enough: in an early version `inApp` was *parsed but never read*, so turning it off left
> the notice appearing anyway. A regression test now pins this.

## Configuration

Settings page: **sidebar → Plugins → dsh-attention-notifier**.

Runtime preferences live in `$DSH_HOME/attention-notifier/settings.json` (atomic write:
temp file + rename). The loader row remains the source of defaults, in the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: attention-notifier
      name: 'dsh-attention-notifier'
      config:
        triggers: { approval: always, question: always, done: unfocused, error: always }
        minDurationMs: 0
        channels: { toast: true, sound: true, inApp: true }
        restoreOnClick: true
        rawFallback: false
        windows: { appId: com.deepseek.dsh, toastTimeoutMs: 10000, soundTimeoutMs: 5000, focusTimeoutMs: 5000 }
        external: []
```

| Field | Default | Meaning |
|---|---|---|
| `triggers.*` | see above | Per-moment policy: `off` / `unfocused` / `always` |
| `minDurationMs` | `0` | Shortest run time worth a "finished" alert. **`always` bypasses it** — otherwise the two settings cancel each other out |
| `channels.toast` | `true` | Windows notification |
| `channels.sound` | `true` | Sound, carried by the toast |
| `channels.inApp` | `true` | In-app notice |
| `restoreOnClick` | `true` | Restore and focus the window when "Open DSH" is used |
| `rawFallback` | `false` | Use `scenario="reminder"`, which persists in the Action Center |
| `windows.appId` | `com.deepseek.dsh` | Toast application id; registered by the installer's Start Menu shortcut |
| `external` | `[]` | Reserved slot for push channels (see Known limitations) |

### "Only when unfocused" needs a page to report focus

`unfocused` fires only when a page has reported the window as not in front. In a pure
terminal / headless setup nothing can report that, so **`unfocused` never fires there**.
If you use DSH from a terminal as well as the desktop window, choose `always`.

## Self-tests in the settings page

Four buttons, each exercising one link in the chain and reporting inline:

- **Test notification** — a normal toast (sound + "Open DSH" button)
- **Test reminder** — the `scenario="reminder"` path (stays in the Action Center)
- **Test sound** — plays `C:\Windows\Media\notify.wav` on its own
- **Test restore window** — drives the `dsh://` single-instance path

**Please press "Test notification" at least once.** Windows Focus Assist / Do Not Disturb
swallows notifications silently and the API returns no error, so this is the only way to
confirm delivery actually works.

### Settings save themselves

There is no Save button. Every control writes as soon as it changes (debounced ~500 ms),
and the status line reports *Saving… / Saved / Save failed* with a **Retry** when a write
fails. Two details make this safe:

- only **user edits** trigger a write (`dirty` flag) — reacting to every draft change would
  echo each poll straight back to the Host;
- the 5-second poll **never overwrites an edit that has not been written yet**, which would
  otherwise silently revert a control you just changed.

## Installation

### From npm

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
npm install dsh-attention-notifier
```

Then enable it under **Plugins → dsh-attention-notifier**. If it is not listed, append to
the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: attention-notifier
      name: 'dsh-attention-notifier'
```

### From source

```powershell
git clone https://github.com/RisingSun785/dsh-attention-notifier.git
cd dsh-attention-notifier
npm test          # 237 assertions, no DSH required
```

Then install it the same way, pointing at your clone (for example `plugin_manager`'s
`install_bundle` with the directory's absolute path as `target`).

### Requirements

| | |
|---|---|
| OS | **Windows** (delivery goes through `powershell.exe` 5.1 + WinRT toast) |
| DSH | Desktop build (`dsh-app://` window plus the `com.deepseek.dsh` toast AppId) |
| Node | ≥ 20 |
| Runtime dependencies | **None** — only `node:*` built-ins |

> On non-Windows platforms the plugin loads but reports `delivery: false`, leaving the
> in-app notice as the only channel. Cross-platform delivery (`osascript` /
> `notify-send`) is not implemented.

## Tests

Two re-runnable suites, **237 assertions**, neither of which displays a notification:

```powershell
# Host half: the four-moment state machine, settings route, injection rows,
#            observation counters, config-less rows (157 assertions)
node ./_statemachine.mjs

# Client half: module contract, slot registrations, waterfall delegation,
#              page lifecycle, autosave (80 assertions)
node ./_client_cases.mjs
```

`npm test` runs both in order. If PowerShell's execution policy blocks `npm.ps1`, use
`npm.cmd test`.

The **Host half** installs a loader hook (`_loader.mjs`) that swaps the Windows delivery
layer for a recorder (`_delivery_stub.mjs`), then drives **the real plugin code** through a
fake Cordis context — so the assertions cover real decisions, not a re-implementation.
Each install gets a fresh Harness home and an empty settings document, so settings cases
cannot leak into later ones.

Coverage includes: each moment's trigger and copy, permission de-duplication by `callId`,
plan-review `detail` selection, the three policies, the duration threshold, suppression for
queued messages / subagents / delegated subsessions, suppression for user aborts and
`interrupted` turns, no false "finished" while an approval is pending, channel fallback,
**delivery consistency across all four moments** (each driven with a real payload, asserting
toast + sound + button), the settings route's read/write/validation/404/405 and hostile-input
normalisation, **the live Plugins-page switch gate** (off silences immediately, on resumes
immediately, unreadable fails open), injection-row structure (the script must also pass a
`new Function` syntax check), and the observation counters.

The **client half** runs `client.js` under Node (plain JS needing only
`window.__ModuleLoader__`, `document`, `fetch` stubs) to verify the registration id equals
the **package name**, the factory returns a valid plugin object, the three slot
registrations, the two Remote Event subscriptions, that **both waterfall listeners call
`next()`**, that a throwing request does not break the flow, page-lifecycle mount/dispose,
and that the settings card renders and reads the plugin's route.

React is stubbed (the page's React comes from the shell's own bundle and is unreachable from
Node), so **rendered output is not asserted**; copy is asserted against the bundle instead.

### What the tests caught

Four real defects, plus three cases where the *test* was wrong rather than the code:

1. **The plugin would fail to load after a restart.** `apply` read `rawConfig ?? Config({})`,
   but `Config` is an **object, not a function** — calling it throws
   `TypeError: Config is not a function`. That branch is exactly the path a restart takes:
   an id-targeted override later in the same patch file replaces the row's whole `config`,
   so the row arrives as `undefined`. The plugin worked all session and then **failed to load
   entirely on the next restart**.
2. **A transient `idle → running` reported a false "finished".** The debounce was a `queued`
   boolean, but "a message wakes the agent immediately after a cancellation" emits `idle`
   then `running` **within one synchronous step**, and the `running` branch cleared the flag
   before the microtask guard ran. Fixed with a per-status-change generation counter plus a
   live status check.
3. **Route 404/405 semantics.** Checking the method before the path made *any* unknown path
   answer 405. Correct order: is the action known (else 404), then is the method allowed
   (else 405).
4. **The "restore window" executable path never resolved.** `reg.exe` output looks like
   `    (Default)    REG_SZ    "C:\…\DeepSeek Harness.exe" "%1"`. The first pattern
   deliberately excluded quotes (to avoid matching `"%1"`), but then the drive letter is
   neither at line start nor after whitespace, so it **never matched** — and this
   installation's path contains a space. Matching the **quoted** form fixed it. This is
   exactly why capability probing (`probe()` reporting `appExe`) earns its place: the
   failure was otherwise silent.
5. **"Waiting for an answer" was silently dead while 234 assertions passed.** The handler
   required `request.wait.callId`, a field that **does not exist** — `dsh-user-questions`
   dispatches only `{ questions, agent, signal }`, and `callId` is assigned internally. The
   test fixtures had invented that field *by reading the implementation*, so they validated
   an input shape that never occurs. Fixtures now copy the real payload from the dispatch
   site, and an assertion pins that no live code reads the invented field.

> **The lesson worth keeping**: write event fixtures from the **dispatch site**, never from
> your own understanding of the code. A fixture derived from the implementation agrees with
> the implementation's mistakes.

### Diagnostics

The plugin writes page-contact state to `$DSH_HOME/attention-notifier/status.json`, refreshed
**on every page contact and every 60 seconds**. The page is invisible from the Host, so this
file is the only self-service proof that the browser half loaded.

| Field | Meaning |
|---|---|
| `client.seen` | **Page contacts. Non-zero proves the client half loaded and ran** |
| `clientProbe` | The page's own request to `/api/attention-notifier/state` (url / ok / status / error / body) |
| `observed` | Observation counters (below) |
| `stats` | Delivery results, including `byKind` per moment |
| `effective` | The resolved settings, so a stale in-memory override is distinguishable from a fresh one |
| `switch` | Whether the Plugins-page switch currently allows alerts, and which profile it read that from |
| `lastToastXml` | The exact toast document last handed to the shell |
| `eventTypes` | Every `session/event` type seen, so "never arrived" is distinguishable from "arrived with an unexpected shape" |

`stats.byKind` counts `attempted` / `toastOk` / `toastFail` **per moment**. With only a
total, "the question alert never fired" and "the completion alert fired twice" look
identical; with per-moment counts, `observed.question = 1` alongside `byKind = {}` localises
the fault to a trigger's own guard rather than the delivery layer.

Observation counters, also shown in the settings page:

| Counter | Meaning |
|---|---|
| status changes | `agent/status` events received. **Non-zero proves the plugin attached to the agent state machine** |
| permission / question | The two waterfall requests received |
| turn ends | `turn/end` events received |
| delivered | Alerts actually sent |
| suppressed | Idle settlements deliberately dropped (queued messages, subagents, too short, policy `off`, user abort, …) |

### Independently verifying that a toast really reached Windows

No plugin involvement needed — the registry records every toast the shell accepted:

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\com.deepseek.dsh' |
  Select-Object LastNotificationAddedTime, PeriodicNotificationCount
```

Both values grow with each successful delivery.

> **Caveat**: `CreateToastNotifier(...).Show(...)` returns success even for an **unregistered
> AppId**, so "no error" does not mean "displayed". The registry count is the real evidence.

## Known limitations

1. **Focus Assist / Do Not Disturb swallows system notifications silently** and the plugin
   cannot detect it (Windows offers no API for ordinary desktop apps). Mitigations:
   `rawFallback`, sound, the in-app notice in parallel, and the self-test buttons. A phone
   push channel is the real fix, but v1 does not implement one (see 4).
2. **Permission alerts only occur in sessions whose policy is `ask`.** The
   `approval/request` waterfall is never dispatched under `never` — the service returns
   `rejected` before dispatch. So a `never` session produces no permission alert by design.
3. **The in-app notice needs a window** (browser or desktop). In a pure terminal / headless
   setup only the system notification and sound remain.
4. **`external` (WeChat / QQ / phone push) is a config slot with no implementation.**
   Neither WeChat nor QQ offers an official personal push API; the realistic route is a
   relay service (Server酱³ / PushPlus / WeCom bot / ntfy / Bark) requiring your own token.
   Unofficial personal-account bridges (Wechaty, PadLocal, hooks) violate WeChat's terms and
   risk account bans, so they are deliberately not built. The channel interface is left in
   `external`.
5. **No remote approval.** Notification channels are outbound-only and must never be used as
   an approval path. Approvals stay in the application.
6. **No taskbar-flash channel** (see above).
7. **Restore goes through the single-instance path** (relaunch → `second-instance` →
   `restore/show/focus`). If DSH has exited, this cold-starts it.
8. **In-app notice messages for completion/failure come from polling** (every 2 seconds), so
   they can lag by up to ~2 seconds. Permission and question alerts are event-driven.

## Implementation notes

Three layers, each shaped by a real DSH constraint:

- **Host half** (`index.js`) — event detection and the state machine, system-level delivery,
  runtime settings persistence, and one `/api/attention-notifier` route.
- **Client half** (`client.js`) — the in-app notice, the settings page, and the
  "is the user actually looking" judgement, which only the page can make.
- **Injected script** (via `webserver/index-inject`) — now only an **opt-in diagnostic strip**
  (`?attention-probe=1`) proving the page can reach the plugin's route; inert in normal use.

Hard constraints, each verified against DSH's source:

- **No custom IPC to the Electron main process.** An unknown message type **terminates the
  Host process** (main.js strictly whitelists what the Host may send). System notifications
  therefore go through `powershell.exe` 5.1's WinRT projection, with zero dependencies.
- **Both waterfall listeners must `return next()`.** The default `next` resolves to
  `unavailable` for `approval/request` (which *denies the tool*) and rejects with
  `NO_PROVIDER` for `user-questions/request`. Anything that fails to delegate hijacks the
  request and displaces the real UI answerer. Both register with `{ prepend: true }` so
  "notify, then hand back to the UI" is deterministic.
- **`agent/status` is emitted only when the status string changes**, and `running` spans the
  whole turn including permission and question waits. Completion therefore uses a generation
  counter plus a live status check.
- **Delivery never blocks the agent.** Every subprocess call has a timeout, `windowsHide`,
  `detached` + `unref`, and a concurrency cap of 8. Failures are logged, never thrown onto
  the agent's path.
- **Text reaches PowerShell through environment variables, never the command line**, and the
  toast's title and body are attached with `CreateTextNode`; the XML itself is built from
  constants only. Session titles and approval reasons can contain arbitrary characters
  (quotes, newlines), so the injection path is closed.
- **The route reuses the connection service's admission check** (Host/Origin fence plus the
  browser session cookie), because the webserver provides no authentication of its own.
  Verified: 401/403 otherwise.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: event listeners, completion state machine, delivery scheduling, settings persistence, HTTP route, injections |
| `config.js` | Self-contained Standard Schema validator (no `@deepseek-ai/schemastery`, which a linked plugin cannot resolve) — and the Schemastery node shape `dsh-settings` walks |
| `win32.js` | Windows delivery: toast, reminder-class toast, sound, window restore, capability probing |
| `client.js` | Client half: notice, settings page, two Remote Event listeners, page self-test probe |
| `cordis.patch.yml` | Row config, composed as both a bundle layer and a profile patch layer |
| `locale/{zh,en}.json` | Plugin card title and description |
| `_statemachine.mjs` / `_cases.mjs` / `_loader.mjs` / `_delivery_stub.mjs` | Host-half tests |
| `_client_cases.mjs` | Client-half tests |
| `references/` | Development-time investigation notes (below) |

## Investigation notes

`references/` holds three technical records written during development. They are equally
useful for building other DSH plugins:

| File | Contents |
|---|---|
| `dsh-plugin-findings.md` | **Read this first.** Hard constraints confirmed by experiment: the Electron IPC whitelist (an unlisted message kills the Host process), the correct WinRT toast recipe and the "unregistered AppId still returns success" trap, automatic page-permission grants, plugin package conventions (the bundle id must equal the package name, `Config` only needs a standard schema, schemastery is unimportable from a linked plugin), the four-moment event contract, and the defects only real-machine testing surfaced |
| `dsh-notification-investigation.md` | The full Windows delivery investigation: main-process source analysis, IPC channel enumeration, AUMID registration checks, and the exact commands and results for toast / sound / window restore |
| `dsh-plugin-authoring-contract.md` | Point-by-point evidence for plugin package structure, the patch dialect, the install mechanism, compatibility gates, and HMR semantics |

## Development

```powershell
# Install through the plugin manager (the recommended path for local development)
# plugin_manager: install_bundle, target = <absolute path to this directory>
```

### ⚠️ Host-half changes require a DSH restart

**The longest-running trap in this project.** `plugin_manager`'s `set_plugin` (disable →
enable) rewrites the loader row's enabled state and recomposes the profile patch, but it does
**not** re-import an already-cached ES module:

| What you changed | How it takes effect |
|---|---|
| `client.js` (browser half) | **No restart** — `dsh-client-hmr` polls the file's bytes every 500 ms and tells the page to re-run the factory over SSE. Refresh the page |
| `index.js` / `config.js` / `win32.js` (Host half) | **Restart DSH** — the module is in the ESM registry and `set_plugin` will not re-import it |
| The profile's `cordis.patch.yml` | **No restart** — HMR watches the file and reconciles loader entries |

Useful when debugging: `apply()`'s first action writes
`$DSH_HOME/attention-notifier/loaded.json` (timestamp + pid). **If that file is not updated,
the Loader never reached the module** — the problem is module re-import, not anything inside
`apply`. And `status.json` is rewritten by a 60-second heartbeat, so **a stale timestamp means
the plugin is not running**, not "nothing happened".

### ⚠️ Renaming the package requires `pnpm install`

The name lives in five places: `package.json`'s `name`, the profile's `dependencies`, the
`bundles` list, `cordis.patch.yml`'s `name` — and the **symlink under `node_modules`**, which
only the package manager can rebuild:

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
```

Skipping it produces `cannot resolve profile bundle "<name>"` (the Plugins page shows
"anomaly"), and because the whole Host context fails to build, **even conversations fail**
with an unhelpful `REQUEST_EXTENSION`.

### ⚠️ The Settings UI rewrites the profile patch

**Symptom**: the plugin "disappeared" once — the manager reported `unknown-plugin` and the
row was gone from the composition.

**Cause**: changing any preference **managed by the settings form** (transcript view, UI
settings, …) makes `configEditor` re-serialise the entire
`profiles/<name>/cordis.patch.yml` **using its own model**. That rewrite keeps **only the
rows it manages**, so:

- a hand-written `- insert: … attention-notifier …` is **dropped entirely**;
- `agent-default-model` is dropped along with it;
- `ui-settings-account`'s `purpose` / `completion` / `developerTools` get reset.

**Current mitigation**: the profile's plugin row is kept **minimal** (`insert` + `id` +
`name`, no `config`), the plugin's own defaults live in `config.js`, and live preferences live
in `$DSH_HOME/attention-notifier/settings.json` (which the settings UI does not touch). Even
if the patch is rewritten, only two lines need restoring.

### How the Plugins-page switch takes effect

DSH's Plugins-page switch **only edits the profile's bundle list**
(`dsh.profile.bundles`). It does **not** add or remove the `- insert:` row, so it **cannot
unload a plugin that is already running** — the row is the sole determinant of whether the
plugin loads.

This plugin therefore turns the switch into a **live gate**: before every alert it re-reads
the profile's bundle list and drops the alert if the plugin is not listed (counting it in
`observed.suppressed`). Consequently:

| Action | Effect | Restart needed? |
|---|---|---|
| Switch **off** in the Plugins page | **Immediately** no alerts (the plugin idles in memory) | No |
| Switch **on** | **Immediately** resumes | No |
| Delete the `- insert:` row | The plugin is genuinely unloaded | No (the patch is HMR-watched) |
| Add the row back | Reloads the plugin | No |

> **Unreadable means enabled** (fail open). A plugin that quietly stops notifying because it
> could not find a preference file is far worse than one that notifies when the user expected
> silence.

Both preconditions must hold: the plugin must be in `bundles` **and** the row must exist.

## License

[MIT](LICENSE) © RisingSun785
