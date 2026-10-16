# DSH Windows Notification Delivery — Investigation Report

Date: investigation run on this machine (Windows 11 专业版, build 10.0.26200).
Scope: can a **Host-side Cordis plugin** deliver a real OS toast / sound / window-focus on Windows.

Legend: **[V]** = verified by reading code or running a command (evidence given). **[I]** = inferred. **[U]** = unknown / not verified.

---

## 0. Artifacts produced

| What | Path |
|---|---|
| asar parser script | `C:\Users\Administrator\AppData\Local\Temp\dsh-asar-x\parse-asar.js` |
| Extraction report | `C:\Users\Administrator\AppData\Local\Temp\dsh-asar-x\asar-report.txt` |
| **Extracted Electron main process** | `C:\Users\Administrator\AppData\Local\Temp\dsh-asar-x\ex-app\lib\main.js` (490,173 B, 12,331 lines) |
| Preloads | `...\ex-app\lib\preload-app.cjs`, `preload-mandatory.cjs`, `preload-platform-account.cjs`, `preload-update-dialog.cjs`, `preload-welcome.cjs` |
| Shell renderer pages | `...\ex-app\renderer\*.html|js|css` |
| Non-dsh asar deps | `...\ex-app\node_modules\@deepseek-ai\{cordis,cosmokit,dsh-api-gateway}` |
| Probes (read-only) | `...\dsh-asar-x\probe.ps1`, `probe2.ps1`, `probe3.ps1` |

asar format used: UInt32LE @12 = header size, JSON header @16, data @16+headerSize. Header was 3,392,048 B.
Top-level asar entries **[V]**:

| entry | files | bytes | unpacked |
|---|---|---|---|
| `dsh` (Node runtime) | 12,412 | 367,105,170 | 1,497 |
| `lib` (Electron main + preloads) | 13 | 939,233 | 0 |
| `node_modules` | 528 | 4,340,225 | 0 |
| `renderer` (shell pages) | 13 | 44,677 | 0 |
| `package.json` | 1 | 757 | 0 |

`package.json`: `@deepseek-ai/dsh-desktop` v0.2.0-rc.2, `"main": "lib/main.js"`, **`"dshDesktopAppId": "com.deepseek.dsh"`** **[V]**

Note: a 1.7 MB `asar-flat-list.json` that my script wrote next to `app.asar` was deleted; `resources\` is back to its original contents.

---

## 1. Electron main process — notification / tray / AUMID

### 1a. `Notification`, tray, `setAppUserModelId` — VERIFIED

`lib/main.js:5` **[V]**:
```js
import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, clipboard, dialog, ipcMain,
         nativeImage, nativeTheme, net, powerMonitor, protocol, session, shell, systemPreferences } from "electron";
```

**`electron.Notification` IS used — but in exactly ONE place, and only for update reminders, `silent: true`.**

`lib/main.js:8865-8928` **[V]** (`DesktopUpdateAttention`):
```js
ready(version, parent, modal, returnToConfirmation) {
    if (this.version === version) return;
    this.version = version;
    if (parent.isFocused() || modal.isFocused()) return;   // only when NOT focused
    ...
    try {
        if (this.platform === "win32") parent.flashFrame(true);
        if (this.platform === "darwin") bounce = app.dock?.bounce("informational");
    } catch (error) { console.warn("desktop update: attention unavailable", error); }
    try {
        if (!Notification.isSupported()) return;
        const notification = new Notification({
            title: this.locale.messages.mandatoryReady,
            body: this.locale.messages.mandatoryNotification,
            silent: true                                  // <-- silent
        });
        this.notification = notification;
        notification.on("failed", ...);
        notification.once("click", () => { ...; this.clear(); returnToConfirmation(); });
        notification.show();
    } catch (error) { console.warn("desktop update: notification unavailable", error); }
}
```
`mandatoryNotification` copy: EN `"Return to the application to confirm installation and restart."` / ZH `"返回应用确认安装并重启。"` (`preload-app.cjs:268`, `:435`).

Other attention APIs used **[V]**: `parent.flashFrame(true/false)` (win32 only, main.js:8898/8902), `app.dock.bounce('informational')` / `cancelBounce` (darwin only). **No `setOverlayIcon`, no `setBadgeCount`, no `setThumbarButtons` anywhere** (grep for `Notification|setAppUserModelId|new Tray|flashFrame|setOverlayIcon|setBadgeCount` across `lib/`).

**`app.setAppUserModelId(...)` is ABSENT.** Case-insensitive `Select-String -Pattern 'setAppUserModelId'` over `main.js` returns **zero** hits **[V]**. The only `AppUserModelId`-shaped strings in the whole extracted app are unrelated (`welcome.css` tokens, a minified `welcome.js` line).

**A Tray IS created — Windows only.** `lib/main.js:10831-10875` **[V]**:
```js
//#region lib/types/tray.js
/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */
var DesktopTray = class {
    constructor(options) {
        this.options = options;
        const tray = new Tray(nativeImage.createFromPath(options.iconPath));
        this.tray = tray;
        tray.on("click", () => { options.open(); });
        this.relabel();
    }
    relabel() {
        tray.setToolTip(messages.aboutProduct);
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: messages.openApplication, click: () => { this.options.open(); } },
            { type: "separator" },
            { label: messages.quitApplication, click: () => { this.options.quit(); } }
        ]));
    }
    dispose() { tray?.destroy(); }
};
```
Wiring, `lib/main.js:11937-11951` **[V]**:
```js
const trayIconPath = development ? join(app.getAppPath(), "resources", "tray-windows.ico")
                                 : join(process.resourcesPath, "tray.ico");
if (process.platform === "win32") try {
    tray = new DesktopTray({ iconPath: trayIconPath, locale: currentDesktopLocale,
        open: () => { focusPrimaryWindow(); },
        quit: () => { app.quit(); } });
} catch (error) { console.warn("desktop tray: unavailable", error); }
```
`resources\tray.ico` exists (15,698 B) **[V]**. Close-to-tray is guarded by a one-time dialog (`DesktopBackgroundNotice`, main.js:10880-10931; copy `"Running tasks will continue. You can reopen the window from the system tray."`).

### 1b. IPC surface — enumerated

#### Electron main ↔ Host child (`process.send` / `process.on('message')`) — COMPLETE LIST

Host child entry **[V]**: `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`
Live process evidence **[V]**: PID 14704 = `"…DeepSeek Harness.exe" --expose-internals "…app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js" …`, parent PID 19216 (Electron main), and it owns the listener on **127.0.0.1:19387**.

**main → Host (only 3 message types)** — `lib/main.js:3737-3806` **[V]**:
```js
child.send({ ...request, requestId }, ...)   // request ∈:
//   { type: "update-tasks",    action: "inspect"|"lock"|"unlock", requestId }
//   { type: "quit-inspection", requestId }
child.send({ type: "shutdown" }, (error) => { ... })
```

**Host → main (only 6 message types)**, gated by a strict validator `lib/main.js:3544-3581` **[V]**:
```js
function isDesktopHostEvent(message) {
    if (typeof message !== "object" || message === null || !("type" in message)) return false;
    const candidate = message;
    switch (candidate.type) {
        case "shutdown-complete": return true;
        case "ready": return typeof candidate.url === "string";
        case "platform-session": { ...session shape checks... }
        case "fatal": return typeof candidate.message === "string" && ...;
        case "update-tasks": return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === "boolean" && ...;
        case "quit-inspection": return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === "boolean" && ...;
        default: return false;
    }
}
```

> ### ⚠️ CRITICAL FOOTGUN — [V]
> `lib/main.js:3698-3703`:
> ```js
> child.on("message", (message) => {
>     if (!isDesktopHostEvent(message)) {
>         this.fail(new Error("dsh desktop host sent an invalid IPC event"));
>         child.kill("SIGTERM");
>         return;
>     }
> ```
> A Host-side plugin that calls `process.send({type:'notify', ...})` (or any unknown type) **kills the Host** and surfaces a fatal error. There is **no** extension point in this channel. Do not attempt it.

Host side of the same protocol **[V]** (`dsh-desktop-host\lib\index.js`): `send()` at L248-257 (`process.connected`/`process.send` guarded), `stop()` at L258-262 (`shutdown-complete` then `process.disconnect()`), inbound `shutdown` L265-268, `quit-inspection` L269-293, `update-tasks` L294-318; outbound `platform-session` L332-333, `ready` L338-339, `fatal` L354-355, and **L341: `injections: ctx.webServer.collectIndexInjections()`**.

#### Electron main ↔ renderer/preload — COMPLETE CHANNEL LIST

`lib/main.js:6193-6219` `DESKTOP_IPC` **[V]** (24 channels):
`dsh-desktop:` + `shortcuts-input`, `shortcuts-close-window`, `shortcuts-get`, `shortcuts-edit`, `shortcuts-changed`, `shortcuts-recording`, `boot`, `enter-workspace`, `onboarding-active`, `onboarding-api-key`, `boot-failed`, `browser-acquire`, `browser-release`, `browser-open-requested`, `directory-pick`, `device-info`, `locale-bootstrap`, `locale-changed`, `updates-status`, `updates-open`, `updates-presentation`, `native-theme-set`, `window-fullscreen`, `windows-appearance`, `windows-menu`.

`lib/main.js:5919-5923` `PLATFORM_IPC` **[V]**: `dsh-platform:` + `bootstrap`, `locale-changed`, `open`, `bounds`, `close`.
`lib/main.js:7747-7756` `WELCOME_IPC` **[V]**: `dsh-welcome:` + `save-api-key`, `analytics`, `analytics-enabled`, `skip`, `start`, `cancel`, `copy-link`, `state`, `take-notice`.
`lib/main.js:8856` `MANDATORY_IPC` **[V]**: `dsh-desktop:mandatory-status|mandatory-state|mandatory-action`.
`lib/main.js:9465-9468` `UPDATE_DIALOG_IPC` **[V]**: `dsh-update-dialog:status|changed|respond`.

Every main→renderer push is one of: `PLATFORM_IPC.localeChanged`, `MANDATORY_IPC.state`, `UPDATE_DIALOG_IPC.changed`, `DESKTOP_IPC.shortcutsInput`, `DESKTOP_IPC.shortcutsChanged`, `DESKTOP_IPC.windowFullscreen`, `WELCOME_IPC.state`, `DESKTOP_IPC.updatesPresentation`, `DESKTOP_IPC.enterWorkspace` **[V]** (grep `webContents.send(`).

**Answer to 2b: NO.** There is no IPC channel, and no preload bridge, that a plugin could use to trigger a native notification. The Host channel is closed (and hostile to unknown types), and the renderer channels are all sender-asserted (`assertDesktopSender` rejects any frame not at `dsh-app://app|shell`, main.js:6221-6231) and semantically unrelated to notifications.

### 1c. Preload globals exposed to the web page (exact names + methods)

`preload-app.cjs` (`contextBridge.exposeInMainWorld`) **[V]**:

| global | available when | methods |
|---|---|---|
| `dshDesktop` | every frame; full API **only** for `dsh-app://app` main frame | `protocolVersion: 1`, `browser.{acquire(workspace), release(lease), onOpenRequested(lease, cb)}`, `deviceInfo()`, `keyboard.{closeWindow(revision), subscribe(cb)}`, `shortcuts.{get(defs), edit(edit, rev), recording(active), subscribe(cb)}`, `updates.{status(), open(), subscribe(cb)}` |
| `dshDesktopBoot` | `dsh-app://app` | `ready()`, `failed(message)` |
| `dshPlatform` | `dsh-app://app` | `open(page, bounds)`, `setBounds(bounds)`, `close()` |
| `dshOnboarding` | `dsh-app://app` | `hasApiKey()`, `setActive(active)` |
| `__DSH_LOCALE__` | `dsh-app://app` | `read()`, `onChange(locale)` |
| `__DSH_DIRECTORY_PICKER__` | `dsh-app://app` | `pick()` |
| `__DSH_HOST_PATHS__` | `dsh-app://app` | `pathFor(file)` |
| `dshMandatoryUpdate` | only at `dsh-app://shell/mandatory-update.html` | `status()`, `action(action, version, confirmationRevision)`, `subscribe(cb)` |
| `dshUpdateDialog` | only at `dsh-app://shell/update-dialog.html` | `status()`, `respond(revision, index)`, `subscribe(cb)` |
| `dshWelcome` | welcome window | `analytics`, `analyticsEnabled`, `takeNotice`, `startSignIn`, `cancelSignIn`, `copySignInLink`, `subscribe`, `saveApiKey`, `skip` |
| `dsh` | platform-account view (`preload-platform-account.cjs`) | bootstrap/locale bridge |

Sources: `preload-app.cjs:789-843` (`createProductApi`), `:844-872`, `:876-883`; `preload-mandatory.cjs:25`; `preload-update-dialog.cjs:26`; `preload-welcome.cjs:391`; `preload-platform-account.cjs:37`.

> **There is NO notification concept anywhere in preload/renderer** **[V]** — no `notify`, `toast`, `alert`, or notification-permission bridge. The only `Notification`-shaped strings in `preload-app.cjs` are the i18n key `mandatoryNotification` (copy for the update toast).

Page security context **[V]**: `webPreferences` for the main window (main.js:11099-11107) = `nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, devTools:true`, no `partition` → **`session.defaultSession`**. The live renderer's own argv confirms the scheme privileges: `--standard-schemes=dsh-app --secure-schemes=dsh-app`.

### 1d. The window URL — important correction

`lib/main.js:11272` **[V]**: `const applicationUrl = \`${SCHEME}://app/\`;` where `SCHEME = "dsh-app"` (main.js:6221).
`lib/main.js:11542-11551` **[V]**:
```js
protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname === "shell") return serveWebDocument(request, join(app.getAppPath(), "renderer"));
    if (url.hostname === "app") {
        if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/")
            || ["/favicon.svg","/manifest.webmanifest"].includes(url.pathname))
            return serveWebDocument(request, join(resources.dsh, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist"));
        if (backend.host === void 0 || hostUrl === void 0 || hostCookie === void 0) return Promise.resolve(new Response(null,{status:503}));
        return forwardWebRequest(request, hostUrl, hostCookie);
    }
    return Promise.resolve(new Response(null, { status: 404 }));
});
```
`lib/main.js:11019-11029` **[V]**: `registerSchemesAsPrivileged([{ scheme: "dsh-app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }])`.

So — **the Electron window's page origin is `dsh-app://app/` (a secure context), NOT `http://127.0.0.1:19387`.** `127.0.0.1:19387` is the Host child's HTTP server (verified: PID 14704 owns that listener), used for API/stream forwarding (`forwardWebRequest`) and for external browsers / `dsh web`.

### 1e. Notification permission handling — THE KEY FINDING

`lib/main.js:6274-6296` **[V]**:
```js
function installMicrophonePermissions(session, primary) {
    session.setPermissionCheckHandler((contents, permission, origin, details) => {
        if (permission !== "media") return true;                    // <-- everything else: ALLOW
        return contents != null && contents === primary() && details.isMainFrame && applicationFrame(origin)
            && details.mediaType === "audio" && (...);
    });
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
        if (permission !== "media") { callback(true); return; }     // <-- everything else: AUTO-GRANT, no prompt
        if (!(contents === primary() && details.isMainFrame && applicationFrame(details.requestingUrl) && ...)) { callback(false); return; }
        ...
    });
}
```
Installed on the main window's session, `lib/main.js:11553` **[V]**:
```js
installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents);
```
Only the *microphone* is gated; **`notifications` (and every other non-media permission) is auto-granted with no prompt.** (Separate throwaway sessions for the embedded sidebar browser / policy auth do deny everything — `setPermissionCheckHandler(() => false)`, main.js:6026-6029, 9300-9304, 9763-9767 — but those are not the app page.)

---

## 2. Windows delivery options evaluated independently

### 2a. Browser Web Notification API from the DSH page — VIABLE, zero dependencies **[V for the DSH-side facts]**

Because the page is at `dsh-app://app/` (privileged `secure: true` → secure context) and `session.defaultSession` auto-grants non-media permissions **[V]**, `Notification.requestPermission()` resolves `'granted'` with **no prompt**, and `new Notification(title,{body})` from page JS is permitted. It shows as an OS toast independent of window visibility (minimized or tray-hidden) as long as the renderer is alive. **The Electron app does NOT define a restrictive Notification permission handler — it defines the opposite.** Chromium's own Windows notification backend then displays it under the app's AUMID **[I]**; AUMID branding is unverified (see 2b).
Note: the bundled web frontend never uses this API today **[V]** (the only `Notification` matches in `dist/` are Shiki PHP/SQL grammar files).

### 2b. WinRT toast from a spawned Windows PowerShell 5.1 — VERIFIED availability, all calls synchronous

Shell facts **[V]** (read-only probes; **no toast was displayed, no sound was played**):

| fact | result |
|---|---|
| `powershell.exe` | `5.1.26100.9444`, `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| `pwsh.exe` (PowerShell 7) | **NOT INSTALLED** (not on PATH; `C:\Program Files\PowerShell`, `Program Files (x86)\PowerShell`, `WindowsApps\pwsh.exe` all absent) |
| `Get-Module -ListAvailable BurntToast` | **NOT INSTALLED** |
| `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]` | **RESOLVED** → `Windows.UI.Notifications.ToastNotificationManager`, asm `Windows.UI` |
| `ToastNotificationManager` overloads | `ToastNotifier CreateToastNotifier()` and `ToastNotifier CreateToastNotifier(String applicationId)` |
| `CreateToastNotifier(String)` return type | `Windows.UI.Notifications.ToastNotifier` — **synchronous, NOT `IAsyncOperation`** (so no `AsTask` await helper needed) |
| `ToastNotifier.Show(ToastNotification)` | `Void` (synchronous) |
| `ToastNotificationManager.GetTemplateContent(ToastTemplateType)` | returns `XmlDocument` (synchronous) |
| `ToastNotification` ctor | `ctor(XmlDocument content)` |
| `Windows.Data.Xml.Dom.XmlDocument` | RESOLVED; `LoadXml(String)`, `GetElementsByTagName(String)->XmlNodeList`, `CreateTextNode(String)->XmlText`, `AppendChild(IXmlNode)->IXmlNode`, `GetXml()->String` (all synchronous) |
| `ToastTemplateType` | `ToastImageAndText01..04`, `ToastText01..04` |
| `Add-Type -AssemblyName System.Runtime.WindowsRuntime` | OK (`System.WindowsRuntimeSystemExtensions` resolved) |
| **Start Menu shortcut** | `C:\Users\Administrator\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk` → `System.AppUserModel.ID = **com.deepseek.dsh**`, target `D:\dsh\AppData\DeepSeek Harness\DeepSeek Harness.exe` |
| `HKCU\Software\Classes\AppUserModelId\com.deepseek.dsh` | does not exist (not needed — the Start Menu shortcut provides the AppId) |
| `Get-StartApps` | lists `DeepSeek Harness` → `com.deepseek.dsh`, and `Windows PowerShell` → `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe` |

**Conclusion: use `powershell.exe` (Windows PowerShell 5.1). Do NOT use `pwsh`** — it is not installed here, and PowerShell 7 cannot do WinRT type-literal interop the same way (no `ContentType=WindowsRuntime` type projection without extra shims) **[V for "not installed"; [I] for the PS7 limitation].** BurntToast is not available and must not be assumed. `New-BurntToastNotification` will simply fail.

**AppId:** must be an AUMID that Windows can resolve, otherwise the toast is silently dropped. The correct value here is **`com.deepseek.dsh`** — it is the app's own `System.AppUserModel.ID` on its Start Menu shortcut **[V]**, so the toast will be attributed to "DeepSeek Harness" with its icon. (`com.deepseek.dsh` is *not* a registry `AppUserModelId` key; the shortcut is the registration mechanism, which is sufficient.) **[I]** — the "silently dropped without a registered AppId" rule is Windows' documented behaviour; I verified the AppId *is* registered rather than verifying a drop.

Recommended call (every API in it is signature-verified above; **toast display itself was deliberately NOT executed** — treat as high-confidence [I], not [V]):
```powershell
$appId = 'com.deepseek.dsh'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
         [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).AppendChild($xml.CreateTextNode('TITLE')) | Out-Null
$texts.Item(1).AppendChild($xml.CreateTextNode('BODY'))  | Out-Null
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
```
With sound (see 2c): insert `<audio src="ms-winsoundevent:Notification.Default"/>` into `<toast>` — or build the XML text directly with `$xml.LoadXml('<toast>…</toast>')` (also verified synchronous) instead of `GetTemplateContent`.

Uncertainties to flag: (1) I did not actually display a toast, so end-to-end display on this Windows 11 build 26200 is inferred; (2) WinRT `ToastNotificationManager` is the legacy API on Windows 11 (Windows App SDK notifications supersede it) but is still functional **[I]**; (3) Focus Assist / "Notifications & actions" settings can suppress display even when correct.

### 2c. Sound — VERIFIED available, dependency-free

| option | status |
|---|---|
| `[console]::Beep()` / `[console]::Beep(int,int)` | methods exist **[V]** (not invoked). Blocks; routes through the console beep device — unreliable/muted on some systems **[I]**. |
| `System.Media.SoundPlayer` | type present **[V]**; `New-Object System.Media.SoundPlayer '<wav>'; $p.Load()` succeeded for **both** `C:\Windows\Media\notify.wav` and `C:\Windows\Media\Windows Notify System Generic.wav` **[V]** (deliberately not played). Use `.Play()` (async) rather than `.PlaySync()` (blocks the helper process). |
| `C:\Windows\Media\*.wav` | 70 files **[V]**, incl. `notify.wav` (228,396 B), `ding.wav`, `chimes.wav`, `chord.wav`, `Windows Notify System Generic.wav` (248,092 B), `Windows Notify Calendar/Email/Messaging.wav`, `Windows Print complete.wav`, `Windows Background.wav` |
| Best option | let the **toast** carry the sound (`<audio src="ms-winsoundevent:Notification.Default"/>`) — the OS plays it with the toast regardless of window state, and there is no extra process/blocking. That XML element is not code-verified here **[I]**; `SoundPlayer` is the code-verified fallback. |
| Renderer alternative | `new Audio('…').play()` / WebAudio in the page. Page is a secure context; audio still runs when minimized/hidden. Autoplay gating: `autoplayPolicy` is **not set** in `main.js` **[V]**, so Electron's documented default (`no-user-gesture-required`) applies **[I, from Electron docs — not verified by execution]**. |

### 2d. Pure-Node / dependency options

* **No new dependency is needed for either toast or sound** — spawn `powershell.exe` and let Windows do it. This is the lowest-risk route from the Host child (which has full user rights).
* `node-notifier` / `snoretoast`: would have to be added as plugin dependencies and both ultimately shell out to a bundled `SnoreToast.exe` (or PowerShell). They add supply-chain weight, and `node-notifier`'s Windows path expects a Start Menu shortcut/AUMID too. Not needed given the above.
* DSH already has subprocess services the plugin could reuse instead of raw `child_process`: packages `dsh-subprocess`, `dsh-subprocess-local`, `dsh-pwsh-local`, `dsh-tool-pwsh` exist, and a live process shows `…dsh-subprocess-local\lib\runner.js -- C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe …` **[V]**. **Recommended:** spawn with plain `node:child_process` with `stdio:'ignore'` (simplest, no service lookup); use the DSH service only if the plugin wants DSH's sandbox/observability. (Whether `dsh-subprocess` is reachable from an arbitrary plugin's context is **[U]** — not investigated.)

### 2e. Focus / restore the DSH window — VERIFIED end-to-end path, no DSH changes

`lib/main.js:6867-6877` **[V]**:
```js
function claimDesktopSingleInstance(application, focusOwner) {
    if (!application.requestSingleInstanceLock()) { application.quit(); return false; }
    application.on("second-instance", focusOwner);
    return true;
}
```
`lib/main.js:12169-12188` **[V]**:
```js
focusPrimaryWindow = () => {
    if (quitting) return;
    if (isMandatory()) { mandatoryUI?.focus(); return; }
    const window = welcomeWindow ?? mainWindow;
    if (window === void 0 || window.isDestroyed()) {
        try { createMainWindow(); } catch (error) { reportFatal(error, "main"); return; }
        (backend.state.phase === "ready" ? openInitialWindow() : navigateMain(applicationUrl)).catch(...);
        return;
    }
    if (window === mainWindow && !enteredWorkspace) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
};
...
if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1") app.setAsDefaultProtocolClient("dsh");
app.on("open-url", (event, url) => { event.preventDefault(); if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow(); });
app.on("activate", (_event, hasVisibleWindows) => { if (!hasVisibleWindows) focusPrimaryWindow(); });
```
Registry **[V]**: `HKCU\Software\Classes\dsh` = `URL Protocol`, and `…\dsh\shell\open\command` = `"D:\dsh\AppData\DeepSeek Harness\DeepSeek Harness.exe" "%1"`.

So **any second launch of the app focuses the existing window** — the `second-instance` handler is bound to `focusPrimaryWindow` and is argument-agnostic. From a Host plugin:
```js
require('node:child_process').spawn('cmd.exe', ['/c','start','','dsh://open'], { stdio:'ignore', windowsHide:true, detached:true });
// or simply re-launch the exe:
require('node:child_process').spawn('D:\\dsh\\AppData\\DeepSeek Harness\\DeepSeek Harness.exe', [], { stdio:'ignore', detached:true });
```
Both are **[V]** by construction (registry entry + single-instance lock + `focusPrimaryWindow` = restore→show→focus). Caveat: if the app was fully quit, this cold-starts it instead of focusing; and the tray already offers the same manual action.

Fallback (less reliable) **[I]**: `(New-Object -ComObject WScript.Shell).AppActivate('DeepSeek Harness')` — subject to Windows foreground-lock; may only flash the taskbar.

A plugin **cannot** call Electron `win.restore()/show()/focus()` or `flashFrame()` — no IPC path exists (see 1b).

### 2f. BONUS — a sanctioned Host-plugin → page script channel (`webserver/index-inject`)

This is the one legitimate way a **Host plugin gets code into the DSH page**, and it makes the page's Web Notification API reachable without any DSH modification.

Event name and signature, from DSH's own API catalog **[V]** (`dsh-tool-cordis\lib\types\api-catalog.js:4268-4270`):
```
name: 'webserver/index-inject',
signature: "'webserver/index-inject'(table: IndexInjection[]): void",
```
Emitted by the webserver service **[V]** (`dsh-host-webserver\lib\index.js:350-354`):
```js
collectIndexInjections() {
    const table = [];
    this.ctx.emit("webserver/index-inject", table);   // every subscriber pushes its current rows
    return table;
}
```
Seven shipped plugins already subscribe **[V]**: `dsh-client-connection:822`, `dsh-client-modules:553`, `dsh-client-shortcuts:14`, `dsh-client-ui-settings-account:74`, `dsh-client-ui-settings-models:17`, `dsh-client-ui-sidebar-documentpreview:26`, `dsh-client-ui-theme:92`.

Row kinds **[V]** (`dsh-host-webserver\lib\index.js:24-52`):
```js
case "global":        { placement:"head", markup:`<script>globalThis[name] = value</script>` }
case "script":        { placement: row.placement, markup: `<script>${row.text}</script>` }
case "script-src":    { placement: row.placement, markup: `<script src="..."></script>` }
case "script-preload":{ placement:"head", markup:`<link rel="preload" as="script" href="...">` }
case "style":         { placement:"head", markup:`<style>${row.text}</style>` }
case "html":          { placement: row.placement, markup: row.html }
default: assertNever(row)
```
The Host child ships the table to Electron main **[V]** (`dsh-desktop-host\lib\index.js:341`: `injections: ctx.webServer.collectIndexInjections()`), main stores it and hands it to the page **[V]** (`main.js:11331-11332` `injections = ready.injections;`, `main.js:11560-11568` `DESKTOP_IPC.boot` returns `{ injections, streamBaseUrl }`).

**And the page executes them — verified in the bundled frontend** (`dsh-web-frontend\dist\assets\index-5SrrfWpU.js`) **[V]**:
```js
function fM(e){ throw new Error(`web boot: unknown index injection row ${JSON.stringify(e)}`) }
async function hM(e,n){
  for(const o of e) switch(o.kind){
    case "global": globalThis[o.name]=o.value; break;
    case "script": { const s=document.createElement("script"); s.textContent=o.text;
                     (o.placement==="head"?document.head:document.body).append(s); break }
    case "script-src": await n(o.src); break;
    case "script-preload": break;
    case "style": { const s=document.createElement("style"); s.textContent=o.text; document.head.append(s); break }
    case "html": (o.placement==="head"?document.head:document.body).insertAdjacentHTML("beforeend",o.html); break;
    default: fM(o) } }
const fo = globalThis.dshDesktopBoot;
...
fo.ready().then(async ({injections:s, streamBaseUrl:a}) => {
    globalThis.__DSH_TRANSPORT__ = { ownsHost:true, streamBaseUrl:a };
    await hM(s, f => new Promise((h,m) => { const g=document.createElement("script"); g.src=f; ... }));
    o.resolve()
}).catch(s => { o.reject(s) })
```
So a Host plugin can do:
```js
ctx.on('webserver/index-inject', (table) => {
  table.push({ kind: 'script', placement: 'body', text: `
     if (Notification.permission === 'granted') new Notification(${JSON.stringify(title)}, { body: ${JSON.stringify(body)} });
     else Notification.requestPermission().then(p => { if (p === 'granted') new Notification(...) });
  ` });
});
```
…and that code runs in the page at `dsh-app://app/` where notification permission is auto-granted (§1e) → a real OS toast, no dependency at all.

**Constraints, honestly stated:**
* `collectIndexInjections()` is called **once**, when the Host reports `ready` at startup (`dsh-desktop-host:341`), and `main.js` caches the array once (`:11332`). A plugin added later (HMR / plugin-manager install) will **not** get rows into an already-booted page; an app/Host restart is required. The plugin must therefore be present in the profile's plugin set at startup.
* Rows must be valid: an unknown `kind` makes the page throw `web boot: unknown index injection row`.
* `backgroundThrottling` is **not** disabled in `main.js` **[V]**, so while the window is hidden/minimized Chromium may throttle *timer-driven* page JS. Notification triggers should be **event-driven** (e.g. a WebSocket/SSE event from the Host), not `setInterval`-driven.
* The inline-`script` row executes in page context. `index.html` served to the page carries no CSP meta tag **[V]**, but I did not enumerate response headers from `serveWebDocument` — inline vs `script-src` CSP safety is **[U]**.

---

## 3. Recommendation

### (i) Native OS toast

**Ranked:**

1. **Host plugin → `powershell.exe` (Windows PowerShell 5.1) → WinRT toast with `AppId = com.deepseek.dsh`.** No new dependency, no DSH change, per-call control of title/body/sound/click-through, and the AppId is *verified registered*. Works while minimized or hidden (the helper process is independent of the window). Risk: the helper process is a fresh `powershell.exe` per toast (~100–300 ms). All API signatures verified synchronous; toast display itself not executed here.
2. **Host plugin → `webserver/index-inject` `script` row → page `new Notification()`.** Zero dependencies, zero processes, uses the auto-granted permission verified in `main.js:6275-6283`. Costs: plugin must be loaded before Host `ready`; requires restart to take effect; timer throttling while hidden; AUMID branding unverified.
3. `node-notifier` / `snoretoast` as plugin dependencies — **not recommended**; they add a dependency to do what option 1 does with an OS binary.

Do **not** attempt `process.send({type:'notify'})` — it kills the Host (`main.js:3699-3702`). There is no Electron-main notification IPC.

### (ii) Sound

1. **Carry it on the toast** (`<audio src="ms-winsoundevent:Notification.Default"/>`) — no extra process, correct when minimized. (XML not code-verified here.)
2. **`SoundPlayer` with a verified system WAV** (fallback if no toast): `(New-Object System.Media.SoundPlayer 'C:\Windows\Media\Windows Notify System Generic.wav').Play()` — construction + `Load()` **verified** against real files. Avoid `PlaySync()` (blocks) and prefer it over `[console]::Beep` (works, but harsher and less reliable).
3. Renderer `new Audio(...)` in a page injection — viable, but subject to Electron's autoplay default **[I]**.

### (iii) Focus / restore the DSH window

**Recommended (verified path, no DSH change):** launch a second instance so Electron's single-instance handoff runs `focusPrimaryWindow()` (restore → show → focus):
```js
spawn('cmd.exe', ['/c','start','','dsh://open'], { stdio:'ignore', detached:true, windowsHide:true });
```
or spawn `D:\dsh\AppData\DeepSeek Harness\DeepSeek Harness.exe` with no arguments (the handler ignores argv).
Alternative: the user's existing tray icon (click = `focusPrimaryWindow`) — no plugin needed.
Fallback: `WScript.Shell.AppActivate('DeepSeek Harness')` **[I]**, weaker under Windows foreground-lock rules.

### Infrastructure the plugin must add

* **Toast + sound + focus: nothing.** No DSH change and no plugin dependency — all three are achievable from the Host child with `node:child_process` + the OS. The only "infrastructure" is a spawn helper with a timeout/kill and `stdio:'ignore'`.
* **Page-based notification (option 2):** a `ctx.on('webserver/index-inject', …)` subscription registered at plugin load, i.e. the plugin must be in the profile's startup plugin set. `InjectionTable` rows must use a supported `kind`.
* **What genuinely does not exist in DSH today** — confirmed by the package inventory (no notification/toast/sound package among the ~240 `@deepseek-ai/dsh-*` packages) and by grep: a notification service, an Electron-main notification IPC channel, a preload notification bridge, an app AUMID set at runtime (`setAppUserModelId` absent), and any API for a plugin to focus the window directly.

### Residual unknowns

* End-to-end toast display on this exact Windows 11 build (deliberately not executed, per instructions) — high confidence from registered AppId + verified synchronous API.
* Whether Electron's own renderer/main notifications carry the `com.deepseek.dsh` AUMID for correct branding.
* Electron's `autoplayPolicy` default for renderer audio (not set in `main.js`; Electron-documented default cited).
* Whether `serveWebDocument` emits a CSP that would affect `script-src`/inline injection rows.
* Whether the `dsh-subprocess` service is reachable from an arbitrary plugin context (not investigated).
