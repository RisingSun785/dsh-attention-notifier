/**
 * Attention Notifier - Host half.
 *
 * Watches the four moments where the agent needs the user and raises an alert:
 *   1. `approval/request`       - a tool waits for a permission decision
 *   2. `user-questions/request` - the agent waits for an answer
 *   3. `agent/status` -> idle   - a task finished
 *   4. `agent/error`            - a step or turn failed
 *
 * Design rules this file follows deliberately:
 *
 * - The two waterfall listeners must always `return next()`. The default `next`
 *   for `approval/request` resolves to `unavailable` (which denies the tool) and
 *   for `user-questions/request` rejects with `NO_PROVIDER`; claiming a request
 *   would silently remove the real answerer.
 * - `agent/status` reports transitions only, and an agent whose turn was already
 *   aborted can go idle and immediately running again inside one synchronous
 *   step. The completion branch therefore re-checks on a microtask and drops the
 *   alert when the agent is already running again.
 * - `agent/error` and a user abort are disjoint paths: an aborted turn never
 *   emits `agent/error`, so the abort is read from the durable `turn/end` event.
 * - Delivery can never disturb the agent: every failure is logged and swallowed.
 *
 * The browser half reaches this file over one loopback, cookie-authenticated
 * route mounted under `/api/attention-notifier`. The web server itself carries
 * no authentication, so this plugin reuses the connection service's admission
 * check (Host/Origin fence plus browser session) exactly as the `/api` bridge
 * does, instead of trusting the route.
 */

import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { Config, MODE_VALUES, defaultConfig } from './config.js'
import { focusWindow, isSupported, lastToastXml, playSound, probe, showToast } from './win32.js'

/** Loader identity; the row id in the bundle patch is also the settings namespace. */
const name = 'attention-notifier'

/** Route prefix owned by this plugin. */
const ROUTE_PATH = '/api/attention-notifier'

/** Largest accepted settings body; the page sends a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** How many notifications are retained for a page that has not polled yet. */
const MAX_INBOX = 40

/** Cap on concurrent delivery children, so a stuck shell cannot pile up. */
const MAX_INFLIGHT = 8

/** Actions this route accepts as POST; everything else is a 404. */
const POST_ACTIONS = new Set(['settings', 'test', 'focus'])

/**
 * Resolve the Harness home directory.
 * @returns Absolute path whose sibling folders hold Harness state.
 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const profile = process.env.USERPROFILE ?? process.env.HOME
  if (typeof profile === 'string' && profile.length > 0) return join(profile, '.dsh')
  return process.cwd()
}

/**
 * Locate the active profile directory.
 *
 * The desktop host receives it as a command-line argument, so the argv is the
 * reliable source; the environment variables are only a fallback for other hosts.
 * @returns Absolute profile directory, or undefined when it cannot be determined.
 */
function resolveProfileDir() {
  const fromArgv = process.argv.find((arg) => /[\\/]profiles[\\/][^\\/]+$/u.test(arg))
  if (typeof fromArgv === 'string') return fromArgv
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const profiles = join(resolveHome(), 'profiles')
  try {
    const names = readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    // Only guess when there is exactly one profile; otherwise refusing to guess is
    // safer than reading the wrong profile's preferences.
    if (names.length === 1) return join(profiles, names[0])
  } catch {
    // No profiles directory: this is not a desktop install.
  }
  return undefined
}

/**
 * Whether this plugin is still switched on in the profile.
 *
 * The Plugins page toggle edits `dsh.profile.bundles`; it does **not** add or
 * remove the loader row, so the plugin keeps running after being switched off.
 * Reading the bundle list is therefore the only way to honour the switch, and
 * reading it on every decision - rather than once at load - is what makes the
 * switch take effect immediately instead of at the next restart.
 *
 * Undeterminable means "on". A plugin that silently stops notifying because it
 * could not find a preference file is far worse than one that notifies when the
 * user expected silence.
 *
 * @param dir - Profile directory, or undefined.
 * @param packageName - This plugin's package name.
 * @returns True when notifications should be delivered.
 */
function readProfileEnabled(dir, packageName) {
  if (typeof dir !== 'string' || dir.length === 0) return true
  const pkg = readJson(join(dir, 'package.json'))
  const bundles = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return true
  return bundles.includes(packageName)
}

/**
 * Read a JSON object, tolerating every failure.
 * @param path - Absolute file path.
 * @returns Parsed object, or undefined.
 */
function readJson(path) {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Write a JSON object atomically.
 *
 * Settings are read on every notification, so a torn write left by an earlier
 * crash would be observable; a temporary file plus rename prevents that.
 * @param path - Absolute file path.
 * @param value - Serializable document.
 * @returns true when the write succeeded.
 */
function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(temp, path)
    return true
  } catch (error) {
    // Returning false alone makes a write failure indistinguishable from "never
    // attempted", which is the harder bug to chase; keep the reason.
    writeJson.lastError = error instanceof Error ? error.message : String(error)
    return false
  }
}

/**
 * Validate a trigger mode.
 * @param value - Candidate.
 * @returns A valid mode, or undefined.
 */
function asMode(value) {
  return MODE_VALUES.includes(value) ? value : undefined
}

/**
 * Validate a boolean.
 * @param value - Candidate.
 * @param fallback - Used when the candidate is not a boolean.
 * @returns Boolean.
 */
function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Validate a non-negative integer.
 * @param value - Candidate.
 * @param fallback - Used when the candidate is not a usable number.
 * @returns Non-negative integer.
 */
function asDuration(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.round(n)
}

/**
 * Coerce an `unknown` error into one short line.
 * @param error - Value from `agent/error`.
 * @returns Single-line message.
 */
function errorLine(error) {
  const message = error?.message ?? error?.failure?.message ?? String(error ?? 'unknown error')
  return String(message).replaceAll(/\s+/gu, ' ').slice(0, 300)
}

/**
 * Format a duration for a notification body.
 * @param ms - Milliseconds.
 * @returns Compact Chinese string.
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(rest)} 秒`
}

/**
 * Install the plugin.
 * @param ctx - Plugin-scoped Cordis context.
 * @param rawConfig - Validated row config.
 */
function apply(ctx, rawConfig) {
  const bootMarkerPath = join(resolveHome(), 'attention-notifier', 'loaded.json')

  // The load marker proves the Loader actually invoked this module, which is the
  // one thing that cannot be inferred when a Host-side edit appears to have had no
  // effect (a cached ES module generation re-runs nothing at all).
  //
  // It is written on the NEXT tick, not inline: `apply` runs inside the boot
  // window the desktop shell waits on for its welcome handshake, and a synchronous
  // filesystem write there is avoidable I/O on that path.
  const marker = { at: Date.now(), pid: process.pid, hasConfig: rawConfig !== undefined }
  setImmediate(() => writeJson(bootMarkerPath, marker))

  // A row can arrive with no config: an id-targeted override in the same patch
  // file replaces the whole `config`, and the Loader then validates `undefined`.
  const config = rawConfig ?? defaultConfig()
  const logger = ctx.logger('attention-notifier')

  /** Runtime overrides written by the settings page; the YAML row config stays the default. */
  const overridePath = join(resolveHome(), 'attention-notifier', 'settings.json')

  /**
   * The profile whose Plugins-page toggle decides whether this plugin may notify.
   *
   * Resolved once (it cannot change while the process runs), but read on every
   * delivery so the switch takes effect immediately instead of at the next restart.
   */
  const profileDir = resolveProfileDir()

  /** This plugin's package name, as it appears in `dsh.profile.bundles`. */
  const packageName = 'dsh-attention-notifier'

  /**
   * Whether the Plugins-page switch is currently on.
   * @returns True when the profile still lists this plugin.
   */
  const isEnabled = () => readProfileEnabled(profileDir, packageName)

  /**
   * A small diagnostics document, rewritten whenever the page talks to this plugin.
   *
   * The page is otherwise invisible from the Host, so without this the only way to
   * learn whether the browser half loaded is to ask a human to read the page
   * console. It is a convenience for debugging: the plugin never reads it back,
   * and losing it costs nothing.
   */
  const statusPath = join(resolveHome(), 'attention-notifier', 'status.json')
  const overrides = readJson(overridePath) ?? {}

  /** How many times each `session/event` type has arrived, for diagnostics. */
  const eventTypes = new Map()

  /** Per-session attention state. */
  const sessions = new Map()

  /** Notifications awaiting a page poll. */
  const inbox = []
  let seq = 0
  const stats = {
    inflight: 0,
    toastOk: 0,
    toastFail: 0,
    soundOk: 0,
    soundFail: 0,
    lastError: null,
    /** Per-moment delivery counts, keyed by trigger kind. */
    byKind: {},
  }

  /** Load time, so the observation counters can be read in context. */
  const startedAt = Date.now()

  /**
   * Observation counters.
   *
   * These make the plugin's own wiring auditable: the settings page shows them,
   * so "the plugin is loaded but saw nothing" is distinguishable from "the
   * plugin never loaded". Only counts are kept - no session content.
   */
  const observed = { status: 0, error: 0, turnEnd: 0, approval: 0, question: 0, delivered: 0, suppressed: 0 }

  /**
   * Page-contact counters.
   *
   * The browser half polls the state route whenever it is loaded, so a non-zero
   * `seen` is direct evidence that the client bundle actually reached the page.
   * That is the only such evidence available from the Host, where the page is
   * otherwise invisible.
   */
  const client = { seen: 0, first: 0, last: 0, lastVisible: null, focusReports: 0 }

  /**
   * What the page reported about its own ability to reach this plugin's route.
   *
   * The Electron window is served over the `dsh-app://` scheme rather than over
   * `http://127.0.0.1:<port>`, so a relative `fetch('/api/…')` is not obviously
   * equivalent to the same request from a browser tab. The page half probes its
   * own route at startup and reports the outcome here, which is the only way to
   * observe this from the Host.
   */
  const clientProbe = { url: null, ok: null, status: null, error: null, at: 0, body: null }

  /** Whether the page has ever reported focus, and what it reported. */
  const focus = { reported: false, visible: false, updatedAt: 0, signals: null }

  /**
   * Write the diagnostics document, tolerating every failure.
   * @returns true when the document was written.
   */
  const publishStatus = () =>
    writeJson(statusPath, {
      at: Date.now(),
      since: startedAt,
      platform: process.platform,
      delivery: isSupported(),
      client,
      clientProbe,
      observed,
      stats,
      focus,
      // Whether the Plugins-page switch is currently allowing alerts, plus where the
      // answer came from: "the switch is off" and "the profile could not be found"
      // must not look the same in a diagnosis.
      switch: { enabled: isEnabled(), profileDir: profileDir ?? null },
      // Every `session/event` type seen, so "the event never arrived" is
      // distinguishable from "it arrived with an unexpected shape".
      eventTypes: Object.fromEntries(eventTypes),
      // The resolved settings are published, not just the file on disk: a stale
      // in-memory override is otherwise indistinguishable from a fresh one.
      effective: settings(),
      // The exact toast document last handed to the shell, so "did the notification
      // carry the action button?" is answerable from outside the process.
      lastToastXml: lastToastXml() ?? null,
    })

  /**
   * Resolve effective settings: YAML defaults under the settings document.
   * @returns Fully resolved settings.
   */
  const settings = () => {
    const triggers = { ...config.triggers, ...overrides.triggers }
    const channels = { ...config.channels, ...overrides.channels }
    return {
      triggers: {
        approval: asMode(triggers.approval) ?? config.triggers.approval,
        question: asMode(triggers.question) ?? config.triggers.question,
        done: asMode(triggers.done) ?? config.triggers.done,
        error: asMode(triggers.error) ?? config.triggers.error,
      },
      channels: {
        toast: asBoolean(channels.toast, config.channels.toast),
        sound: asBoolean(channels.sound, config.channels.sound),
        inApp: asBoolean(channels.inApp, config.channels.inApp),
      },
      minDurationMs: asDuration(overrides.minDurationMs, config.minDurationMs),
      restoreOnClick: asBoolean(overrides.restoreOnClick, config.restoreOnClick),
      rawFallback: asBoolean(overrides.rawFallback, config.rawFallback),
      windows: { ...config.windows, ...(overrides.windows ?? {}) },
    }
  }

  /**
   * Whether a mode permits an alert right now.
   * @param mode - Resolved mode.
   * @returns True when the alert should be raised.
   */
  const allows = (mode) => {
    if (mode === 'off') return false
    if (mode === 'always') return true
    // `unfocused` also covers "the page never reported", which is exactly the
    // unattended case this plugin exists for.
    return focus.reported && !focus.visible
  }

  /**
   * Whether a finished turn clears the reporting threshold.
   *
   * "Always" has to bypass the threshold, otherwise the two settings cancel each
   * other out: choosing "report every completion" while a positive
   * `minDurationMs` silently drops the short ones is a contradiction the user
   * cannot see. The threshold only shapes the default `unfocused` mode.
   * @param mode - Resolved mode for the completion trigger.
   * @param durationMs - Measured turn duration.
   * @param thresholdMs - Configured `minDurationMs`.
   * @returns True when the completion should be reported.
   */
  const passesThreshold = (mode, durationMs, thresholdMs) => {
    if (mode === 'always') return true
    return durationMs >= thresholdMs
  }

  /**
   * Per-session record, created on demand.
   * @param sessionId - Session identity.
   * @returns Mutable record.
   */
  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        startedAt: undefined,
        lastDurationMs: undefined,
        interrupted: false,
        aborted: false,
        errored: null,
        approvals: 0,
        questions: 0,
        idleGeneration: 0,
        lastApprovalKey: undefined,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * Human-readable session label.
   *
   * The title service is optional (`sessionTitle`) and a session has no title
   * before its first eligible input, so this degrades to the workspace folder
   * and finally to the session id.
   * @param agent - Live agent.
   * @returns Short label.
   */
  const sessionLabel = (agent) => {
    try {
      const title = ctx.get('sessionTitle')?.get?.(agent.session)?.title
      if (typeof title === 'string' && title.trim().length > 0) return title.trim()
    } catch {
      // The optional service can reject on a stale session; fall through.
    }
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) {
      const parts = cwd.split(/[\\/]+/u).filter((part) => part.length > 0)
      if (parts.length > 0) return parts[parts.length - 1]
    }
    return String(agent?.id ?? 'session')
  }

  /**
   * Queue one notification and start delivery.
   * @param kind - Trigger that produced it.
   * @param agent - Live agent, when known.
   * @param fields - Title and body text.
   */
  const notify = (kind, agent, fields) => {
    seq += 1
    const message = {
      seq,
      at: Date.now(),
      kind,
      sessionId: agent?.id === undefined ? null : String(agent.id),
      title: fields.title,
      body: fields.body,
      severity: kind === 'error' ? 'error' : kind === 'done' ? 'done' : 'attention',
    }
    // The single funnel every alert passes through, so this is where the
    // Plugins-page switch is honoured. The switch only edits the profile's bundle
    // list; it cannot unload a running plugin. Reading it per decision is what
    // makes "off" mean off immediately rather than at the next restart.
    if (!isEnabled()) {
      observed.suppressed += 1
      return
    }
    observed.delivered += 1
    const resolved = settings()
    // The page polls this queue and raises the in-app notice from it, so the
    // `inApp` channel has to gate the queue itself. Gating only the renderer left
    // the switch inert: the messages kept arriving and the notice kept appearing
    // with the channel turned off.
    if (resolved.channels.inApp) {
      inbox.push(message)
      if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX)
    }
    deliver(message, resolved)
  }

  /**
   * Deliver a notification out of page.
   *
   * Fire and forget: the promise is settled here and never returned to a caller
   * on the agent's path.
   * @param message - Queued notification.
   * @param resolved - Effective settings.
   */
  const deliver = (message, resolved) => {
    if (stats.inflight >= MAX_INFLIGHT) {
      stats.lastError = 'delivery queue saturated; one alert was dropped'
      logger.warn(stats.lastError)
      return
    }
    stats.inflight += 1
    // Per-moment counters. A single `toastOk` total cannot tell "the question
    // alert never fired" apart from "the completion alert fired twice" - a
    // distinction that decides whether the fault is in the trigger or the
    // delivery, and which the aggregate counters hide.
    const perKind = (stats.byKind[message.kind] ??= { attempted: 0, toastOk: 0, toastFail: 0 })
    perKind.attempted += 1
    const jobs = []
    if (resolved.channels.toast && isSupported()) {
      // The toast document carries its own sound, so `sound` is folded in here
      // rather than played separately.
      jobs.push(
        showToast({
          title: message.title,
          body: message.body,
          sound: resolved.channels.sound,
          raw: resolved.rawFallback,
          // The user may be looking at another application entirely, and nothing
          // inside a minimized window is visible, so the toast's own action button
          // is the only route back to the session.
          focusAction: resolved.restoreOnClick,
          appId: resolved.windows.appId,
          timeoutMs: resolved.windows.toastTimeoutMs,
        }).then((result) => {
          if (result.ok) {
            stats.toastOk += 1
            perKind.toastOk += 1
          } else {
            stats.toastFail += 1
            perKind.toastFail += 1
            stats.lastError = `toast: ${result.error}`
          }
        }),

      )
    } else if (resolved.channels.sound && isSupported()) {
      jobs.push(
        playSound({ timeoutMs: resolved.windows.soundTimeoutMs }).then((result) => {
          if (result.ok) stats.soundOk += 1
          else {
            stats.soundFail += 1
            stats.lastError = `sound: ${result.error}`
          }
        }),
      )
    }
    void Promise.allSettled(jobs).then(
      () => {
        stats.inflight -= 1
      },
      () => {
        stats.inflight -= 1
      },
    )
  }

  // ---- Trigger 1: an approval is waiting -------------------------------------

  ctx.on(
    'approval/request',
    (request, next) => {
      observed.approval += 1
      try {
        const agent = request?.agent
        if (agent !== undefined && agent !== null) {
          const state = stateFor(agent.id)
          state.approvals += 1
          const key = `${String(request.toolName ?? 'tool')}:${String(request.callId ?? '')}`
          // A sandbox escalation can re-ask for the same tool call; one call must
          // not produce two alerts.
          if (state.lastApprovalKey !== key) {
            state.lastApprovalKey = key
            const resolved = settings()
            if (allows(resolved.triggers.approval)) {
              const reason = request.displayReason?.zh ?? request.displayReason?.en ?? request.reason
              const detail = typeof reason === 'string' && reason.length > 0
                ? reason
                : `${String(request.toolName)} 请求越权执行`
              notify('approval', agent, {
                title: `需要你确认：${sessionLabel(agent)}`,
                body: detail.slice(0, 400),
              })
            }
          }
        }
      } catch (error) {
        logger.warn(`approval notification failed: ${String(error)}`)
      }
      return next()
    },
    { prepend: true },
  )

  // ---- Trigger 2: a question is waiting --------------------------------------

  ctx.on(
    'user-questions/request',
    (request, next) => {
      observed.question += 1
      try {
        // The waterfall dispatches `{ ...request, agent }` where `request` carries
        // only `questions` and `signal` (`dsh-user-questions` `ask()`), so the
        // fields actually available here are exactly those two plus the agent.
        //
        // An earlier version also required `request.wait.callId`, a field that does
        // not exist: the guard never passed, `notify` was never reached, and the
        // question moment was silently dead. `callId` is assigned internally by the
        // service and is not part of this payload at all - the question's own `id`,
        // or `intent.callId` for a plan review, is the closest stable identity.
        const agent = request?.agent
        const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
        if (agent !== undefined && agent !== null && first !== undefined) {
          const state = stateFor(agent.id)
          state.questions += 1
          const resolved = settings()
          if (allows(resolved.triggers.question)) {
            // Matches the official client's test: a plan review is an intent of
            // kind `plan-review`, and it always carries the detail under review.
            const planReview = first.intent?.kind === 'plan-review'
            notify('question', agent, {
              title: planReview ? `计划等待评审：${sessionLabel(agent)}` : `需要你回答：${sessionLabel(agent)}`,
              body: String(planReview && first.detail !== undefined ? first.detail : first.question ?? '').slice(0, 400)
                || '智能体正在等待你的回答',
            })
          }
        }
      } catch (error) {
        logger.warn(`question notification failed: ${String(error)}`)
      }
      return next()
    },
    { prepend: true },
  )

  // ---- Triggers 3 and 4: completion and failure ------------------------------

  /**
   * Decide what an idle transition means once the scheduler has settled.
   *
   * Runs on a microtask so a cancelled turn that immediately resumes is observed
   * as `running` and dropped. Two independent guards catch that case: the
   * generation must still be current (no later status edge arrived), and the live
   * status must read `idle`. The generation check is the authoritative one,
   * because the resumption can be observed before `agent.status` reflects it.
   *
   * @param agent - Agent that went idle.
   * @param state - Session record.
   * @param generation - Idle generation captured at the idle edge.
   * @param resolved - Effective settings captured at the idle edge.
   */
  function settleIdle(agent, state, generation, resolved) {
    const raisedBefore = observed.delivered
    try {
      if (state.idleGeneration !== generation) return
      if (agent.status !== 'idle') return
      const inboxPending = (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0
      if (inboxPending) return
      const header = agent.session?.header
      if (header?.origin === 'subagent' || header?.parentSession !== undefined) return
      if (state.approvals > 0 || state.questions > 0) return

      const durationMs = state.lastDurationMs
        ?? (state.startedAt === undefined ? 0 : Date.now() - state.startedAt)
      state.startedAt = undefined
      state.lastDurationMs = undefined

      if (state.errored !== null) {
        const message = state.errored
        state.errored = null
        state.aborted = false
        state.interrupted = false
        if (allows(resolved.triggers.error)) {
          notify('error', agent, {
            title: `任务出错：${sessionLabel(agent)}`,
            body: `${message} · 已运行 ${formatDuration(durationMs)}`,
          })
        }
        return
      }
      if (state.aborted) {
        state.aborted = false
        return
      }
      if (state.interrupted) {
        state.interrupted = false
        return
      }
      if (!passesThreshold(resolved.triggers.done, durationMs, resolved.minDurationMs)) return
      if (!allows(resolved.triggers.done)) return
      notify('done', agent, {
        title: `任务完成：${sessionLabel(agent)}`,
        body: `运行 ${formatDuration(durationMs)} 后完成，可以查看结果了`,
      })
    } catch (error) {
      logger.warn(`idle handling failed: ${String(error)}`)
    } finally {
      // A settled idle that raised nothing was deliberately suppressed.
      if (observed.delivered === raisedBefore) observed.suppressed += 1
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    observed.status += 1
    try {
      if (agent === undefined || agent === null) return
      const state = stateFor(agent.id)
      // Every edge invalidates an in-flight idle decision, so a cancelled turn
      // that resumes inside the same step is never reported as finished.
      state.idleGeneration += 1
      if (status === 'running') {
        if (state.startedAt === undefined) state.startedAt = Date.now()
        return
      }
      if (status !== 'idle') return
      queueMicrotask(() => settleIdle(agent, state, state.idleGeneration, settings()))
    } catch (error) {
      logger.warn(`status handling failed: ${String(error)}`)
    }
  })

  ctx.on('agent/error', ({ agent, error }) => {
    observed.error += 1
    try {
      if (agent === undefined || agent === null) return
      stateFor(agent.id).errored = errorLine(error)
    } catch (error_) {
      logger.warn(`error handling failed: ${String(error_)}`)
    }
  })

  // Durable turn outcome. An aborted turn never emits `agent/error`, so this is
  // the only place a user stop is told apart from a completion.
  ctx.on('session/event', (session, event) => {
    // Record the event type before any filtering. Counters alone cannot tell "the
    // event never arrived" apart from "the event arrived with an unexpected shape",
    // and that difference decides whether the fault is the subscription or the
    // parsing.
    if (eventTypes.size < 40) eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1)
    try {
      if (event?.type !== 'turn/end') return
      observed.turnEnd += 1
      const state = stateFor(session.id)
      const kind = event.data?.reason?.kind
      if (kind === 'completed') state.lastDurationMs = event.data?.durationMs
      state.interrupted = kind === 'interrupted'
      state.aborted = kind === 'aborted'
    } catch {
      // A malformed event must not disturb the session feed.
    }
  })

  ctx.on('session/disposed', (session) => {
    sessions.delete(session.id)
  })

  // ---- Settings persistence --------------------------------------------------

  /**
   * Merge a settings patch from the settings page.
   * @param patch - Partial settings; unknown keys are ignored.
   * @returns Effective settings after the write.
   */
  const applyPatch = (patch) => {
    if (typeof patch !== 'object' || patch === null) return settings()
    const base = settings()
    const triggers = patch.triggers ?? {}
    overrides.triggers = {
      approval: asMode(triggers.approval) ?? base.triggers.approval,
      question: asMode(triggers.question) ?? base.triggers.question,
      done: asMode(triggers.done) ?? base.triggers.done,
      error: asMode(triggers.error) ?? base.triggers.error,
    }
    const channels = patch.channels ?? {}
    overrides.channels = {
      toast: asBoolean(channels.toast, base.channels.toast),
      sound: asBoolean(channels.sound, base.channels.sound),
      inApp: asBoolean(channels.inApp, base.channels.inApp),
    }
    if (patch.minDurationMs !== undefined) {
      overrides.minDurationMs = asDuration(patch.minDurationMs, base.minDurationMs)
    }
    if (patch.restoreOnClick !== undefined) {
      overrides.restoreOnClick = asBoolean(patch.restoreOnClick, base.restoreOnClick)
    }
    if (patch.rawFallback !== undefined) {
      overrides.rawFallback = asBoolean(patch.rawFallback, base.rawFallback)
    }
    if (!writeJson(overridePath, overrides)) logger.warn('could not persist notification settings')
    return settings()
  }

  // ---- Page-facing route -----------------------------------------------------

  /**
   * Read a JSON request body with a hard size bound.
   * @param req - Incoming request.
   * @returns Parsed value, or undefined.
   */
  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Send one JSON response.
   * @param res - Server response.
   * @param status - HTTP status.
   * @param value - Serializable body.
   */
  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * Answer one page request.
   *
   * The admission check is the same one the `/api` bridge uses - a loopback
   * Host/Origin fence followed by the browser session cookie - because the web
   * server itself has no authentication of its own.
   * @param req - Incoming request.
   * @param res - Server response.
   */
  const handleRequest = async (req, res) => {
    try {
      const connection = ctx.get('connection')
      if (connection === undefined || typeof connection.admit !== 'function') {
        sendJson(res, 503, { ok: false, error: 'connection service unavailable' })
        return
      }
      const admission = connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const action = url.pathname.slice(ROUTE_PATH.length).replace(/^\/+/u, '')

      // Any request from the browser half proves the client bundle loaded.
      client.seen += 1
      if (client.first === 0) client.first = Date.now()
      client.last = Date.now()
      publishStatus()

      if (action === 'state') {
        const raw = Number(url.searchParams.get('cursor') ?? '0')
        const cursor = Number.isFinite(raw) ? raw : 0
        const visible = url.searchParams.get('visible')
        if (visible !== null) {
          focus.reported = true
          focus.visible = visible === '1'
          focus.updatedAt = Date.now()
          client.lastVisible = focus.visible
        }
        // The page's raw visibility/focus reading, so the "unfocused" policy can be
        // diagnosed from the Host instead of inferred.
        const signals = url.searchParams.get('signals')
        if (signals !== null) focus.signals = signals.slice(0, 60)
        const live = settings()
        sendJson(res, 200, {
          ok: true,
          seq,
          // With the in-app channel off, the page is told about nothing: a message
          // queued before the switch was flipped must not surface afterwards.
          messages: live.channels.inApp
            ? inbox.filter((message) => message.seq > cursor)
            : [],
          config: live,
          focus: { ...focus },
          // Why alerts are or are not being delivered, readable from the page.
          switch: { enabled: isEnabled(), profileDir: profileDir ?? null },
          stats: { ...stats, supported: isSupported(), platform: process.platform },
          observed: { ...observed, since: startedAt },
          client: { ...client },
          clientProbe: { ...clientProbe },
          probe: probe(),
        })
        return
      }

      // The page reports how its own route request went; see `clientProbe`. This
      // one accepts GET so the report still arrives even when the page cannot
      // read a response, which is exactly the case being diagnosed.
      if (action === 'client-probe-report') {
        clientProbe.url = url.searchParams.get('url')?.slice(0, 300) ?? null
        clientProbe.ok = url.searchParams.get('ok') === '1'
        const status = Number(url.searchParams.get('status'))
        clientProbe.status = Number.isFinite(status) ? status : null
        clientProbe.error = url.searchParams.get('error')?.slice(0, 300) ?? null
        clientProbe.body = url.searchParams.get('body')?.slice(0, 300) ?? null
        clientProbe.at = Date.now()
        publishStatus()
        sendJson(res, 200, { ok: true })
        return
      }

      // An unknown path is a 404 whatever the method; only a known action with the
      // wrong method is a 405.
      if (!POST_ACTIONS.has(action)) {
        sendJson(res, 404, { ok: false, error: `unknown action: ${String(action)}` })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readBody(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }

      if (action === 'settings') {
        sendJson(res, 200, { ok: true, config: applyPatch(body) })
        return
      }
      if (action === 'test') {
        const resolved = settings()
        const requested = body.action
        if (requested === 'toast' || requested === 'raw') {
          sendJson(res, 200, await showToast({
            title: 'DeepSeek Harness',
            body: requested === 'raw'
              ? '这是一条“提醒”类通知，会保留在操作中心。'
              : '这是一条测试通知：注意力提醒插件工作正常。',
            sound: resolved.channels.sound,
            raw: requested === 'raw',
            appId: resolved.windows.appId,
            timeoutMs: resolved.windows.toastTimeoutMs,
          }))
          return
        }
        if (requested === 'sound') {
          sendJson(res, 200, await playSound({ timeoutMs: resolved.windows.soundTimeoutMs }))
          return
        }
        if (requested === 'focus') {
          sendJson(res, 200, await focusWindow({ timeoutMs: resolved.windows.focusTimeoutMs }))
          return
        }
        sendJson(res, 400, { ok: false, error: `unknown action: ${String(requested)}` })
        return
      }

      if (action === 'focus') {
        // Counted separately from the poll: this action is only sent by the page's
        // change listeners, so a non-zero count proves the instant reporting is
        // live and not merely the two-second poll arriving eventually.
        client.focusReports += 1
        focus.reported = true
        focus.visible = body.visible === true
        focus.updatedAt = Date.now()
        client.lastVisible = focus.visible
        const focusSignals = url.searchParams.get('signals')
        if (focusSignals !== null) focus.signals = focusSignals.slice(0, 60)
        // Persist immediately: an instant focus report exists precisely because the
        // next 60s heartbeat is far too late to be useful in a diagnosis.
        publishStatus()
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { ok: false, error: `unknown action: ${String(action)}` })
    } catch (error) {
      logger.warn(`route failed: ${String(error)}`)
      try {
        sendJson(res, 500, { ok: false, error: 'internal error' })
      } catch {
        // The response may already be committed; nothing left to do.
      }
    }
  }

  // The web wiring is the only part of this plugin that touches a service another
  // plugin owns, so it is also the only part that can collide with a shared
  // resource (a route path, an index injection slot). Routing that failure through
  // the logger keeps a collision from failing plugin activation - and, more
  // importantly, from failing the whole boot, which presents to the user as an
  // unexplained startup error.
  //
  // It is also deferred to the next tick. The desktop shell shows a welcome window
  // that calls into the Host as soon as it is up, and reports
  // `desktop welcome: Web RPC failed` when the Host is not ready in time; a route
  // registration and two listener registrations are real work to place inside that
  // window for no benefit, because nothing can request the route before boot
  // finishes.
  setImmediate(() => {
    const webCtx = ctx.get('webServer')
    if (webCtx === undefined) {
      logger.warn('webServer is unavailable; the settings page will not be reachable')
      return
    }
    try {
      ctx.effect(
        () => webCtx.register({ kind: 'prefix', path: ROUTE_PATH, handler: handleRequest }),
        'attention-notifier: page route',
      )
    } catch (error) {
      logger.error(`could not register ${ROUTE_PATH}: ${String(error)}`)
      return
    }

    // The rendered page is the only place this plugin can put content without a
    // slot of its own. The client half draws the notice; these injections only
    // carry the opt-in diagnostic strip and the notice animation style.
    ctx.on('webserver/index-inject', (table) => {
      // An opt-in diagnostic strip, independent of the client bundle. Opening the
      // app with ?attention-probe=1 shows whether this page can reach the plugin's
      // route at all, which separates "the client half never loaded" from "the
      // route is unreachable from this origin".
      table.push({
        kind: 'script',
        placement: 'body',
        text: `(function () {
  if (!/[?&]attention-probe=1/.test(location.search)) return;
  if (window.__DSH_ATTENTION_PROBE__) return;
  window.__DSH_ATTENTION_PROBE__ = true;
  var run = function () {
    var box = document.createElement('div');
    box.setAttribute('data-dsh-attention-probe', 'strip');
    box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;max-width:560px;'
      + 'padding:10px 12px;border-radius:10px;font:12px/18px system-ui,sans-serif;'
      + 'background:rgba(20,20,24,.94);color:#fff;white-space:pre-wrap;word-break:break-all';
    box.textContent = 'attention-probe: checking ' + location.origin + ' ...';
    document.body.appendChild(box);
    fetch('/api/attention-notifier/state', { credentials: 'same-origin' })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, ok: r.ok, body: t.slice(0, 200) }; }); })
      .then(function (result) {
        box.textContent = 'attention-probe: origin=' + location.origin
          + '\\nstatus=' + result.status + ' ok=' + result.ok
          + '\\nbody=' + result.body;
      })
      .catch(function (error) {
        box.textContent = 'attention-probe: origin=' + location.origin
          + '\\nFETCH FAILED: ' + (error && error.message ? error.message : String(error));
      });
  };
  if (document.body) run();
  else document.addEventListener('DOMContentLoaded', run);
})();`,
      })

      table.push({
        kind: 'style',
        text: `.dsh-attention-notice { animation: dshAttentionIn .22s ease-out }
@keyframes dshAttentionIn {
  from { opacity: 0; transform: translateY(-10px) scale(.985) }
  to { opacity: 1; transform: translateY(0) scale(1) }
}
@keyframes dshAttentionPop { from { opacity: 0; transform: scale(.5) } to { opacity: 1; transform: scale(1) } }
.dsh-attention-badge {
  display: block; width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  animation: dshAttentionPop .2s ease-out;
}`,
      })
    })
  })

  const pruneTimer = setInterval(() => {
    // The heartbeat doubles as a liveness proof for the diagnostics document: a
    // stale file then means "the plugin is not running", not "nothing happened".
    if (!publishStatus()) {
      logger.warn(`could not write ${statusPath}: ${String(writeJson.lastError ?? 'unknown')}`)
    }
    if (sessions.size <= 200) return
    for (const [id, state] of sessions) {
      const busy = state.approvals > 0 || state.questions > 0 || state.startedAt !== undefined
      const fresh = state.lastDurationMs !== undefined || state.errored !== null
      if (!busy && !fresh) sessions.delete(id)
      if (sessions.size <= 200) break
    }
  }, 60_000)
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref()
  ctx.effect(() => () => clearInterval(pruneTimer))

  logger.info(
    `ready; delivery ${isSupported() ? 'available' : 'unavailable'}; settings file ${overridePath}`,
  )
  // The first diagnostics write is deferred to the next tick for the same reason
  // as the load marker: keep synchronous I/O out of the boot window.
  setImmediate(() => {
    if (!publishStatus()) {
      logger.warn(`could not write ${statusPath}: ${String(writeJson.lastError ?? 'unknown')}`)
    }
  })
  if (!isSupported()) {
    logger.warn('Windows notifications and sound need PowerShell 5.1; the in-app channels stay active')
  }
}

export { Config, apply, name }
