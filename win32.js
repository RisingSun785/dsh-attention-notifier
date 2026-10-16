/**
 * Windows delivery layer for the attention notifier.
 *
 * Deliberately dependency-free: every action is performed by spawning
 * `powershell.exe` (Windows PowerShell 5.1, which resolves the WinRT
 * projections) or the desktop application itself.
 *
 * Two hard constraints shape this file:
 *
 * 1. The Electron main process must not receive custom IPC events - an
 *    unrecognised message type terminates the whole Host process. Nothing here
 *    touches Electron IPC.
 * 2. `pwsh` (PowerShell 7) is not installed and cannot project WinRT without an
 *    extra await helper, so the toast path targets `powershell.exe` only.
 *
 * Every function resolves to a result object and never throws: a notification
 * that cannot be delivered must never disturb the agent.
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Windows PowerShell 5.1 - the only shell on this machine that projects WinRT. */
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/** Toast application identity registered by the desktop installer's Start Menu shortcut. */
export const DEFAULT_APP_ID = 'com.deepseek.dsh'

/** Notification sounds to try, in order. All present on a stock Windows 10/11. */
const SOUND_CANDIDATES = [
  'notify.wav',
  'Windows Notify System Generic.wav',
  'Windows Notify Calendar.wav',
  'ding.wav',
]

/** Registry key the desktop app registers for its single-instance `dsh://` scheme. */
const APP_PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh\\shell\\open\\command'

let resolvedAppExe
let resolvedAppExeProbed = false
let soundPath
let soundProbed = false

/** The toast document built by the most recent {@link showToast} call. */
let lastXml

/** True when this delivery layer can do anything at all. */
export function isSupported() {
  return process.platform === 'win32' && existsSync(POWERSHELL)
}

/**
 * Encode a PowerShell script for `-EncodedCommand` (UTF-16LE base64).
 *
 * The encoded form carries no quoting, escaping, or `%` expansion hazards, which
 * matters because the script is transported verbatim on the command line.
 * @param script - PowerShell source.
 * @returns Base64 payload for `-EncodedCommand`.
 */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Run one PowerShell script to completion.
 *
 * Untrusted text travels in the environment rather than on the command line, so
 * a session title or an approval reason can never change the script's meaning.
 * @param script - PowerShell source; must not embed dynamic text.
 * @param env - Extra environment entries; a value cannot become code.
 * @param timeoutMs - Upper bound before the child is killed.
 * @returns Outcome, or a failure result; never rejects.
 */
function runPowershell(script, env, timeoutMs) {
  return new Promise((resolve) => {
    if (!isSupported()) {
      resolve({ ok: false, error: 'not supported on this platform' })
      return
    }
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      child = execFile(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
        {
          env: { ...process.env, ...env },
          windowsHide: true,
          timeout: timeoutMs,
          // Bounded output: a diagnostic must not be able to grow without limit.
          maxBuffer: 64 * 1024,
        },
        (error, _stdout, stderr) => {
          if (error === null) {
            finish({ ok: true })
            return
          }
          const detail = String(stderr ?? '').trim() || error.message
          finish({ ok: false, error: detail })
        },
      )
      child.on('error', (error) => finish({ ok: false, error: error.message }))
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * Escape a string for use as XML text content.
 * @param value - Untrusted text.
 * @returns XML-safe text.
 */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Build the toast document.
 *
 * Text nodes are attached with `CreateTextNode`, so the only escaping this needs
 * is for the title/body that will be set as *text* - they are read from the
 * environment inside PowerShell and appended as DOM text nodes.
 *
 * Reaching the app from a toast needs one of two mechanisms, and both are emitted
 * when the focus action is on:
 *
 * - `launch="dsh://open" activationType="protocol"` on the `<toast>` element makes
 *   the **whole notification** clickable. This is the reliable one: Windows 11
 *   renders a collapsed toast as two lines of text and places action buttons in a
 *   region that only appears on hover or in the Action Center, so a button-only
 *   toast looks like it has no way to act at all.
 * - an `<actions>` button labelled "打开 DSH" is kept as the discoverable,
 *   explicit affordance once the notification is expanded.
 *
 * Both activate `dsh://open`, which this installation registers and whose handler
 * calls `focusPrimaryWindow()`.
 *
 * @param options - Whether to include the notification sound, whether to use the
 *   reminder scenario (which stays in the Action Center), and whether to offer the
 *   focus activation.
 * @returns Complete `<toast>` XML, with two empty `<text>` placeholders.
 */
function buildToastXml(options) {
  const scenarios = options.raw ? ' scenario="reminder"' : ''
  const duration = options.raw ? ' duration="long"' : ''
  const launch = options.focusAction
    ? ' launch="dsh://open" activationType="protocol"'
    : ''
  const audio = options.sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : ''
  const actions = options.focusAction
    ? '<actions><action content="打开 DSH" activationType="protocol" arguments="dsh://open"/></actions>'
    : ''
  return [
    `<toast${scenarios}${duration}${launch}>`,
    '<visual><binding template="ToastGeneric"><text></text><text></text></binding></visual>',
    audio,
    actions,
    '</toast>',
  ].join('')
}

/** PowerShell body that projects WinRT, builds the document, and shows it. */
function toastScript(xml) {
  // `xml` is generated by buildToastXml from constants only - never from user text.
  const escapedXml = xml.replaceAll("'", "''")
  return [
    "$ErrorActionPreference='Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml('${escapedXml}')`,
    "$nodes = $doc.GetElementsByTagName('text')",
    "$nodes.Item(0).AppendChild($doc.CreateTextNode($env:DSH_NOTIFY_TITLE)) | Out-Null",
    "$nodes.Item(1).AppendChild($doc.CreateTextNode($env:DSH_NOTIFY_BODY)) | Out-Null",
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:DSH_NOTIFY_APPID)",
    '$notifier.Show($toast)',
  ].join('; ')
}

/**
 * The toast document built by the most recent {@link showToast} call.
 *
 * Exposed for diagnostics: "did the notification carry the action button?" is
 * otherwise unanswerable from outside the process, because the shell reports only
 * that it accepted a toast. PowerShell 5.1 needs the document as an
 * `-EncodedCommand` payload anyway, so keeping the last one costs nothing.
 * @returns The last built XML, or undefined before the first toast.
 */
export function lastToastXml() {
  return lastXml
}

/**
 * Show a Windows toast notification.
 * @param options - Title, body, whether to play the notification sound, whether to
 *   prefer the reminder scenario, whether to offer the "open DSH" action, the toast
 *   application id, and the time bound.
 * @returns Delivery outcome; `ok` only means the shell accepted the toast.
 */
export function showToast(options) {
  const xml = buildToastXml({
    sound: options.sound,
    raw: options.raw,
    // Off by default so the diagnostic buttons can test the plain form; the
    // notification path turns it on.
    focusAction: options.focusAction === true,
  })
  lastXml = xml
  return runPowershell(toastScript(xml), {
    DSH_NOTIFY_TITLE: String(options.title ?? ''),
    DSH_NOTIFY_BODY: String(options.body ?? ''),
    DSH_NOTIFY_APPID: String(options.appId ?? DEFAULT_APP_ID),
  }, options.timeoutMs ?? 10000)
}

/**
 * Resolve a notification WAV from the Windows media directory.
 * @returns Absolute path of the first candidate that exists, or undefined.
 */
export function resolveSound() {
  if (soundPath !== undefined) return soundPath
  if (soundProbed) return undefined
  soundProbed = true
  const media = join(process.env.SystemRoot ?? 'C:\\Windows', 'Media')
  for (const name of SOUND_CANDIDATES) {
    const candidate = join(media, name)
    if (existsSync(candidate)) {
      soundPath = candidate
      return soundPath
    }
  }
  return undefined
}

/**
 * Play a notification sound.
 *
 * Uses `Play()` rather than `PlaySync()` so a missing audio endpoint cannot hold
 * the child open until its timeout.
 * @param options - Optional WAV override from the runtime settings, and the time bound.
 * @returns Delivery outcome.
 */
export function playSound(options = {}) {
  const requested = typeof options.wav === 'string' && options.wav.length > 0 ? options.wav : undefined
  const wav = requested !== undefined && existsSync(requested) ? requested : resolveSound()
  if (wav === undefined) return Promise.resolve({ ok: false, error: 'no notification sound found' })
  const script = "(New-Object Media.SoundPlayer $env:DSH_NOTIFY_WAV).Play()"
  return runPowershell(script, { DSH_NOTIFY_WAV: wav }, options.timeoutMs ?? 5000)
}

/**
 * Read the application executable registered for the `dsh://` scheme.
 *
 * The desktop app registers the scheme and focuses its existing window when a
 * second instance starts, so this is the only sanctioned way to raise the
 * window from the Host process.
 *
 * `reg.exe` renders the value as `    (Default)    REG_SZ    "C:\…\app.exe" "%1"`.
 * The quoted form must be matched FIRST: the executable path itself can contain
 * spaces (this installation is `…\DeepSeek Harness\DeepSeek Harness.exe`), and a
 * pattern anchored on whitespace before the drive letter never matches it.
 * Quoting is also what makes this unambiguous, since it skips the `"%1"`
 * placeholder.
 *
 * @returns Executable path, or undefined when the probe fails.
 */
function resolveAppExecutable() {
  if (resolvedAppExe !== undefined) return resolvedAppExe
  if (resolvedAppExeProbed) return undefined
  resolvedAppExeProbed = true
  const envCandidates = [process.env.DSH_DESKTOP_APP_EXE, process.env.DSH_APP_EXE]
  for (const candidate of envCandidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) {
      resolvedAppExe = candidate
      return resolvedAppExe
    }
  }
  try {
    const value = execFileSync('reg.exe', ['query', APP_PROTOCOL_KEY, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    const match = /"([A-Za-z]:\\[^"]+?\.exe)"/u.exec(value)
    if (match !== null && existsSync(match[1])) {
      resolvedAppExe = match[1]
      return resolvedAppExe
    }
  } catch {
    // The scheme may not be registered (portable run); fall through.
  }
  resolvedAppExe = undefined
  return undefined
}

/**
 * Raise and focus the desktop window.
 *
 * Starting the executable again reaches the app's single-instance handler,
 * which restores, shows, and focuses the primary window.
 * @param options - Time bound for the launch.
 * @returns Launch outcome; a detached success does not prove focus changed.
 */
export function focusWindow(options = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'not supported' })
  const exe = resolveAppExecutable()
  const launch = exe === undefined
    ? () => spawn('cmd.exe', ['/c', 'start', '', 'dsh://open'], { detached: true, stdio: 'ignore', windowsHide: true })
    : () => spawn(exe, ['dsh://open'], { detached: true, stdio: 'ignore', windowsHide: true })
  return new Promise((resolve) => {
    try {
      const child = launch()
      child.on('error', (error) => resolve({ ok: false, error: error.message }))
      child.unref()
      // A successful spawn is all this can observe; the window may still be cold-starting.
      resolve({ ok: true, detail: exe === undefined ? 'cmd dsh://open' : exe })
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * Probe the delivery stack without producing a visible notification.
 *
 * Reports which capabilities are available so the settings page can tell the
 * user why nothing happened instead of failing silently.
 * @returns Capability report.
 */
export function probe() {
  return {
    supported: isSupported(),
    powershell: POWERSHELL,
    powershellPresent: existsSync(POWERSHELL),
    sound: resolveSound(),
    // Resolving the app executable is what the "restore window" action depends on;
    // it is probed here so the settings page can report it before the action runs.
    appExe: resolveAppExecutable() ?? null,
  }
}
