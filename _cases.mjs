/**
 * Throwaway cases for the Host half's four-moment state machine.
 *
 * Delivery is redirected to a recorder by `_loader.mjs`, so every assertion here
 * observes a real decision made by `index.js`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Redirect the settings document into a throwaway directory BEFORE the plugin
// module loads, so these cases never touch the real profile's preferences
// (index.js resolves the path once, at apply time).
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-attention-test-'))

const { apply } = await import('./index.js')
const { calls, reset } = await import('./_delivery_stub.mjs')

const listeners = new Map()

/** Route registered by the plugin through `ctx.inject(['webServer'], …)`. */
let route

/** Minimal Cordis stand-in covering exactly the verbs this plugin uses. */
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  get: (key) => {
    if (key === 'connection') return { admit: () => ({ peer: {} }) }
    // The plugin reads webServer by key and registers its route on a later tick,
    // so the stub exposes the same service shape here.
    if (key === 'webServer') {
      return {
        register: (registration) => {
          route = registration
          return () => {}
        },
      }
    }
    return undefined
  },
  on(name, listener, options) {
    const list = listeners.get(name) ?? []
    if (options?.prepend === true) list.unshift(listener)
    else list.push(listener)
    listeners.set(name, list)
    return () => {}
  },
  inject(deps, callback) {
    // Retained for the service the plugin still injects; the real plugin only
    // reaches webServer through ctx.get, which the stub answers above.
    void deps
    void callback
    return () => {}
  },
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

/**
 * Install the plugin with a given configuration.
 *
 * Each call gets its own Harness home with an empty settings document, so a
 * settings case earlier in the run cannot leak into a later one: the plugin
 * re-reads that file on every apply.
 *
 * The route registration is deferred to the next tick on purpose (see `apply`),
 * so this awaits one turn before returning.
 * @param overrides - Partial config replacing the test defaults.
 * @returns Promise resolving once the deferred registration has run.
 */
async function install(overrides = {}) {
  listeners.clear()
  reset()
  route = undefined
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-attention-test-'))
  // The plugin honours the Plugins-page switch by reading the profile's bundle
  // list, and this shell exports the real profile directory. Point that at the
  // throwaway home so the cases exercise the plugin, not the developer's profile.
  process.env.DSH_PROFILE_DIR = join(process.env.DSH_HOME, 'profiles', 'test')
  apply(ctx, {
    triggers: { approval: 'always', question: 'always', done: 'always', error: 'always', ...overrides.triggers },
    minDurationMs: overrides.minDurationMs ?? 0,
    channels: { toast: true, sound: true, inApp: true, ...overrides.channels },
    restoreOnClick: overrides.restoreOnClick ?? true,
    rawFallback: false,
    windows: { appId: 'com.deepseek.dsh', toastTimeoutMs: 1000, soundTimeoutMs: 1000, focusTimeoutMs: 1000 },
    external: [],
  })
  await new Promise((resolve) => setImmediate(resolve))
}

const emit = (name, ...args) => {
  for (const listener of listeners.get(name) ?? []) listener(...args)
}

/**
 * Build a fake agent for the counter cases.
 * @param id - Session identity.
 * @returns A fake agent with status transitions, as `agentFor` provides.
 */
function agentForCounters(id) {
  return agentFor(id)
}

/**
 * Build a fake agent exposing the fields the plugin reads.
 *
 * `agent` is one mutable object, as the runtime exposes it: the transition
 * helpers flip `status` in place and then dispatch, so the plugin's live
 * `agent.status` read sees the current value rather than a stale copy.
 * @param id - Session identity.
 * @param extra - Extra session header fields.
 * @returns A fake agent with a shared session and status transitions.
 */
function agentFor(id, extra = {}) {
  const agent = {
    id,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    session: { id, header: { id, cwd: 'D:\\work\\my-proj', ...extra } },
  }
  const emitStatus = (status) => {
    agent.status = status
    emit('agent/status', { agent, status })
  }
  return {
    agent,
    session: agent.session,
    toRunning: () => emitStatus('running'),
    toIdle: () => emitStatus('idle'),
  }
}

/** Run one waterfall dispatch in listener order. */
const waterfall = async (name, request) => {
  const list = [...(listeners.get(name) ?? [])]
  let index = 0
  const step = async () => {
    const listener = list[index]
    index += 1
    if (listener === undefined) return { answers: [] }
    return listener(request, step)
  }
  return step()
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

let pass = 0
let fail = 0
/**
 * Assert one expectation.
 * @param label - What is being checked.
 * @param condition - Expected outcome.
 */
function check(label, condition) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}`)
  }
}

const toasts = () => calls.filter((call) => call.kind === 'toast')
const titles = () => toasts().map((call) => String(call.title))

console.log('T1 approval')
await install()
await waterfall('approval/request', {
  agent: agentFor('s1').agent,
  toolName: 'pwsh',
  callId: 'call-1',
  reason: 'escalate sandbox to danger-full-access: write outside the workspace',
  displayReason: { en: 'Allow danger-full-access', zh: '允许本次操作使用 danger-full-access 权限' },
})
await tick()
check('raises exactly one alert', calls.length === 1)
check('alert is a toast', calls[0]?.kind === 'toast')
check('title names the moment', titles()[0]?.includes('需要你确认') === true)
check('body uses the localized displayReason', String(toasts()[0]?.body).includes('danger-full-access'))
check('toast carries the sound', toasts()[0]?.sound === true)

const retry = agentFor('s1')
await waterfall('approval/request', { agent: retry.agent, toolName: 'pwsh', callId: 'call-1', reason: 'retry' })
await tick()
check('the same tool call does not alert twice', calls.length === 1)

await waterfall('approval/request', { agent: retry.agent, toolName: 'pwsh', callId: 'call-2', reason: 'another call' })
await tick()
check('a different tool call alerts again', calls.length === 2)

console.log('\nT2 questions')
await install()
await waterfall('user-questions/request', {
  agent: agentFor('s1').agent,
  questions: [{ id: 'q1', question: '要我把改动提交到 main 吗？' }],
})
await tick()
check('ordinary question alerts', titles()[0]?.includes('需要你回答') === true)
check('body carries the question text', String(toasts()[0]?.body).includes('提交到 main'))

// The exact payload `dsh-user-questions` dispatches is `{ ...request, agent }`,
// where `request` holds only `questions` and `signal`. An earlier guard also
// required a `wait.callId` that never exists, so the whole moment was silently
// dead; fixtures that invented that field are what hid it.
{
  reset()
  await waterfall('user-questions/request', {
    agent: agentFor('s1').agent,
    questions: [{ id: 'q-real', question: 'real shape?', header: 'h', options: [{ label: 'yes' }], multiSelect: false }],
    signal: new AbortController().signal,
  })
  await tick()
  check('the real payload shape (no wait field) alerts', toasts().length === 1, toasts().length)
  // Assert the code, not the docs: the comment above explains the old bug and does
  // name the field, so strip comment lines before looking for a live read of it.
  const pluginSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const codeOnly = pluginSource
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  check('no live code reads a wait field', !/\bwait\s*\?*\.\s*callId/.test(codeOnly))
}

reset()
await waterfall('user-questions/request', {
  agent: agentFor('s1').agent,
  questions: [{ id: 'q2', detail: '计划正文', question: '批准这个计划？', intent: { kind: 'plan-review', approve: '批准' } }],
})
await tick()
check('plan review is labelled separately', titles()[0]?.includes('计划等待评审') === true)
check('plan review shows the detail under review', String(toasts()[0]?.body).includes('计划正文'))

reset()
await waterfall('user-questions/request', { questions: [{ id: 'q3', question: 'programmatic' }] })
await tick()
check('agentless request is ignored', calls.length === 0)

console.log('\nT2 question policy off')
await install({ triggers: { approval: 'always', question: 'off', done: 'always', error: 'always' } })
await waterfall('user-questions/request', {
  agent: agentFor('s1').agent,
  questions: [{ id: 'q1', question: 'ignored?' }],
})
await tick()
check('question mode off suppresses the alert', calls.length === 0)

console.log('\nT3 completion')
await install()
const done = agentFor('s2')
done.toRunning()
done.toIdle()
await tick()
check('completion alerts', titles()[0]?.includes('任务完成') === true)
check('body reports a duration', String(toasts()[0]?.body).includes('运行'))

reset()
const busy = agentFor('s3')
busy.agent.inbox.nextTurn.push({ id: 'm1' })
busy.toRunning()
busy.toIdle()
await tick()
check('queued inbox work suppresses the alert', calls.length === 0)

reset()
const sub = agentFor('s4', { origin: 'subagent' })
sub.toRunning()
sub.toIdle()
await tick()
check('subagent suppresses the alert', calls.length === 0)

reset()
const child = agentFor('s4b', { parentSession: 'session-parent' })
child.toRunning()
child.toIdle()
await tick()
check('delegated child suppresses the alert', calls.length === 0)

reset()
const flip = agentFor('s5')
flip.toRunning()
flip.toIdle()
// The scheduler resumes inside the same synchronous step, as it does when a
// message wakes an agent whose previous turn was already cancelled.
flip.toRunning()
await tick()
check('transient idle -> running is not reported as finished', calls.length === 0)

flip.toIdle()
await tick()
check('the real completion afterwards still alerts', calls.length === 1)

console.log('\nT4 error and abort')
await install()
const bad = agentFor('s7')
bad.toRunning()
emit('agent/error', { agent: bad.agent, turn: 1, step: 0, error: new Error('provider request failed') })
bad.toIdle()
await tick()
check('error alerts', titles()[0]?.includes('任务出错') === true)
check('body carries the error message', String(toasts()[0]?.body).includes('provider request failed'))

reset()
const stopped = agentFor('s8')
stopped.toRunning()
emit('session/event', stopped.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
})
stopped.toIdle()
await tick()
check('user abort is not reported as finished or failed', calls.length === 0)

reset()
const interrupted = agentFor('s9')
interrupted.toRunning()
emit('session/event', interrupted.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
interrupted.toIdle()
await tick()
check('an interrupted turn is not reported finished', calls.length === 0)

console.log('\npending-window suppression')
reset()
const waiting = agentFor('s10')
waiting.toRunning()
await waterfall('approval/request', { agent: waiting.agent, toolName: 'pwsh', callId: 'call-9', reason: 'x' })
waiting.toIdle()
await tick()
check('exactly the approval alert is raised while pending', calls.length === 1)
check('no completion alert while an approval is pending', !titles().some((title) => title.includes('任务完成')))

console.log('\nduration threshold (applies to the "unfocused" mode)')
await install({ minDurationMs: 30000, triggers: { approval: 'always', question: 'always', done: 'unfocused', error: 'always' } })
// The page must have reported focus for "unfocused" to permit an alert at all.
await callRoute('GET', '/api/attention-notifier/state?visible=0')
const quick = agentFor('s11')
quick.toRunning()
emit('session/event', quick.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' }, durationMs: 1200 },
})
quick.toIdle()
await tick()
check('a turn shorter than minDurationMs is silent', calls.length === 0)

reset()
const long = agentFor('s12')
long.toRunning()
emit('session/event', long.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' }, durationMs: 45000 },
})
long.toIdle()
await tick()
check('a turn longer than minDurationMs alerts', calls.length === 1)
check('body reports the measured duration', String(toasts()[0]?.body).includes('45'))

console.log('\n"always" is not silently cancelled by the threshold')
// Regression: choosing "report every completion" while a positive minDurationMs
// dropped the short ones made the two settings contradict each other invisibly.
await install({
  minDurationMs: 30000,
  triggers: { approval: 'always', question: 'always', done: 'always', error: 'always' },
})
const shortAlways = agentFor('s12b')
shortAlways.toRunning()
emit('session/event', shortAlways.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' }, durationMs: 800 },
})
shortAlways.toIdle()
await tick()
check('a short turn still alerts under "always"', calls.length === 1, calls.length)

console.log('\nthe notification carries the action button')
// The toast's action is what lets a user whose window is minimized get back to the
// session; nothing inside a minimized window is visible. The XML shape is asserted
// against the real builder in the capability phase, so here the check is that the
// plugin actually asks for it.
await install({ minDurationMs: 0, restoreOnClick: true })
const withAction = agentFor('s12c')
withAction.toRunning()
emit('session/event', withAction.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
withAction.toIdle()
await tick()
check('the toast asks for the focus action', toasts()[0]?.focusAction === true, toasts()[0]?.focusAction)

reset()
await install({ minDurationMs: 0, restoreOnClick: false })
const withoutAction = agentFor('s12d')
withoutAction.toRunning()
emit('session/event', withoutAction.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
withoutAction.toIdle()
await tick()
check('restoreOnClick false drops the action', toasts()[0]?.focusAction === false, toasts()[0]?.focusAction)

console.log('\nevery moment delivers through the same channels')
// The four triggers share one funnel, so an alert must not be weaker for one moment
// than another. This is asserted per moment rather than on the total, because a
// total cannot show that one trigger silently stopped producing a toast.
{
  const perMoment = [
    ['approval', 's12m', () => {
      emit('approval/request', {
        agent: agentFor('s12m').agent,
        toolName: 'shell',
        callId: 'call-1',
        reason: 'run a command',
      }, () => 'unavailable')
    }],
    ['question', 's12n', () => {
      emit('user-questions/request', {
        agent: agentFor('s12n').agent,
        questions: [{ id: 'q-test', question: 'which one?', intent: { kind: 'ask' } }],
      }, () => undefined)
    }],
    ['error', 's12o', () => {
      // The error alert is raised on the idle edge, not on the error event itself:
      // `settleIdle` is what turns a recorded failure into a notification, and it
      // requires the agent to actually reach `idle`.
      const a = agentFor('s12o')
      a.toRunning()
      emit('agent/error', { agent: a.agent, turn: 1, step: 0, error: new Error('boom') })
      a.toIdle()
    }],
    ['done', 's12p', () => {
      const a = agentFor('s12p')
      a.toRunning()
      emit('session/event', a.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      a.toIdle()
    }],
  ]

  for (const [kind, id, fire] of perMoment) {
    reset()
    // `always` on every trigger so the moment's own gate cannot be the reason.
    await install({
      minDurationMs: 0,
      restoreOnClick: true,
      triggers: { approval: 'always', question: 'always', done: 'always', error: 'always' },
    })
    agentFor(id)
    fire()
    await tick()
    const toast = toasts()[0]
    check(`${kind}: a toast is delivered`, toast !== undefined, toasts().length)
    check(`${kind}: the toast carries the sound flag`, toast?.sound === true, toast?.sound)
    check(`${kind}: the toast carries the focus action`, toast?.focusAction === true, toast?.focusAction)
    check(`${kind}: the toast carries a title and body`, typeof toast?.title === 'string' && typeof toast?.body === 'string')
  }

  // And the per-moment counters distinguish the moments.
  const withCounters = (await callRoute('GET', '/api/attention-notifier/state')).parsed
  check('delivery is counted per moment', typeof withCounters.stats.byKind?.done?.toastOk === 'number', JSON.stringify(withCounters.stats.byKind))
}

console.log('\nerror mode off')
await install({ triggers: { approval: 'always', question: 'always', done: 'always', error: 'off' } })
const quiet = agentFor('s13')
quiet.toRunning()
emit('agent/error', { agent: quiet.agent, turn: 1, step: 0, error: new Error('boom') })
quiet.toIdle()
await tick()
check('error mode off suppresses the alert', calls.length === 0)

console.log('\nsound-only channel')
await install({ channels: { toast: false, sound: true, inApp: true } })
const silent = agentFor('s14')
silent.toRunning()
silent.toIdle()
await tick()
check('toast off falls back to a standalone sound', calls.length === 1 && calls[0].kind === 'sound')

console.log('\nno out-of-page channel')
await install({ channels: { toast: false, sound: false, inApp: true } })
const noChannel = agentFor('s15')
noChannel.toRunning()
noChannel.toIdle()
await tick()
check('no delivery attempt is made', calls.length === 0)

console.log('\nsettings route')
await install()

/**
 * Invoke the registered route with a synthesized request.
 * @param method - HTTP method.
 * @param url - Request URL including the query string.
 * @param body - JSON-serializable body, or undefined for no body.
 * @returns Status, parsed JSON, and raw body.
 */
async function callRoute(method, url, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield Buffer.from(payload, 'utf8')
    },
  }
  let status
  let raw = ''
  const headers = {}
  const res = {
    writeHead(code, next) {
      status = code
      Object.assign(headers, next ?? {})
      return res
    },
    end(chunk) {
      if (chunk !== undefined) raw = String(chunk)
      return res
    },
  }
  await route.handler(req, res)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  return { status, parsed, raw, headers }
}

const state = await callRoute('GET', '/api/attention-notifier/state?cursor=0&visible=0')
check('state answers 200', state.status === 200)
check('state reports the plugin probe', state.parsed?.probe?.supported === true)
check('state reports the focus the page sent', state.parsed?.focus?.reported === true && state.parsed.focus.visible === false)
check('state carries the effective config', state.parsed?.config?.triggers?.done === 'always')

const saved = await callRoute('POST', '/api/attention-notifier/settings', {
  triggers: { approval: 'unfocused', question: 'off', done: 'always', error: 'always' },
  channels: { toast: false, sound: true, inApp: true },
  minDurationMs: 5000,
  rawFallback: true,
})
check('settings save answers 200', saved.status === 200)
check('save echoes the merged config', saved.parsed?.config?.triggers?.question === 'off')
check('save echoes the channel change', saved.parsed?.config?.channels?.toast === false)
check('save echoes the new threshold', saved.parsed?.config?.minDurationMs === 5000)

const reread = await callRoute('GET', '/api/attention-notifier/state')
check('the change survives a re-read', reread.parsed?.config?.triggers?.approval === 'unfocused')
check('unsaved fields keep their value', reread.parsed?.config?.channels?.sound === true)

// Hostile input must be normalized, never stored raw.
const hostile = await callRoute('POST', '/api/attention-notifier/settings', {
  triggers: { approval: 'always; DROP TABLE', question: 42 },
  channels: { toast: 'yes' },
  minDurationMs: -9999,
})
check('an invalid mode is rejected', hostile.parsed?.config?.triggers?.approval === 'unfocused')
check('a non-string mode falls back', hostile.parsed?.config?.triggers?.question === 'off')
check('a non-boolean channel falls back', hostile.parsed?.config?.channels?.toast === false)
check('a negative duration is rejected', hostile.parsed?.config?.minDurationMs === 5000)

const malformed = await callRoute('POST', '/api/attention-notifier/settings', undefined)
check('an empty body is treated as no change', malformed.status === 200)

const unknown = await callRoute('GET', '/api/attention-notifier/nope')
check('an unknown action answers 404', unknown.status === 404)

const wrongMethod = await callRoute('DELETE', '/api/attention-notifier/settings')
check('an unsupported method answers 405', wrongMethod.status === 405)

const flashGone = await callRoute('POST', '/api/attention-notifier/test', { action: 'flash' })
check('the removed flash action answers 400', flashGone.status === 400, flashGone.status)
const clearGone = await callRoute('POST', '/api/attention-notifier/clear-flash', {})
check('the removed clear-flash route answers 404', clearGone.status === 404, clearGone.status)

const badTest = await callRoute('POST', '/api/attention-notifier/test', { action: 'nonsense' })
check('an unknown test action answers 400', badTest.status === 400)

console.log('\nindex injection rows')
// The web server hands its injection table to every listener; the plugin must
// contribute the opt-in diagnostic strip and the notice stylesheet.
const injected = []
for (const listener of listeners.get('webserver/index-inject') ?? []) listener(injected)

const scripts = injected.filter((row) => row.kind === 'script')
const styleRow = injected.filter((row) => row.kind === 'style')
const probeRow = scripts.find((row) => String(row.text).includes('__DSH_ATTENTION_PROBE__'))
check('contributes one style row', styleRow.length === 1, styleRow.length)
check('contributes the opt-in diagnostic strip', probeRow !== undefined)
// The title-flash helper used to live here; it injected a `●` document-title
// prefix that this window never renders, so the whole channel was removed rather
// than left as a switch that could not do anything.
check('no longer injects the removed flash helper', !injected.some((row) => String(row.text).includes('__DSH_ATTENTION__')))
check('the script rows are placed in the body', scripts.every((row) => row.placement === 'body'))
check('the diagnostic strip is opt-in only', String(probeRow?.text).includes('attention-probe=1'))
check('the diagnostic strip is guarded against double installation', String(probeRow?.text).includes('if (window.__DSH_ATTENTION_PROBE__) return;'))
check('the style animates the notice in', String(styleRow[0]?.text).includes('dsh-attention-notice'))
check('the style styles the severity dot', String(styleRow[0]?.text).includes('dsh-attention-badge'))
for (const [index, row] of scripts.entries()) {
  check(`injected script #${String(index + 1)} is syntactically valid`, (() => {
    try {
      // The rows are injected verbatim into the page, so a syntax error there
      // would break the app shell rather than this plugin.
      new Function(String(row.text))
      return true
    } catch {
      return false
    }
  })())
}

console.log('\nobservation counters')
// A fresh instance clears the module-level state, but the counters are
// cumulative for the process, so every case below asserts an increment.
await install({ triggers: { approval: 'always', question: 'always', done: 'always', error: 'always' } })
let snapshot = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check('counters are published', typeof snapshot.observed.status === 'number')
check('the load time is published', typeof snapshot.observed.since === 'number' && snapshot.observed.since > 0)

const statusBefore = snapshot.observed.status
const deliveredBefore = snapshot.observed.delivered
const errorBefore = snapshot.observed.error
const suppressedBefore = snapshot.observed.suppressed

agentForCounters('count-1').toRunning()
agentForCounters('count-1').toIdle()
await tick()
const failed = agentForCounters('count-2')
failed.toRunning()
emit('agent/error', { agent: failed.agent, turn: 1, step: 0, error: new Error('x') })
failed.toIdle()
await tick()
snapshot = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check(
  'status transitions were counted',
  snapshot.observed.status - statusBefore === 4,
  snapshot.observed.status - statusBefore,
)
check('the error was counted', snapshot.observed.error - errorBefore === 1, snapshot.observed.error - errorBefore)
check(
  'both notifications were counted as delivered',
  snapshot.observed.delivered - deliveredBefore === 2,
  snapshot.observed.delivered - deliveredBefore,
)

const busyAgent = agentForCounters('count-3')
busyAgent.agent.inbox.nextTurn.push({ id: 'm' })
busyAgent.toRunning()
busyAgent.toIdle()
await tick()
snapshot = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check(
  'a suppressed idle was counted',
  snapshot.observed.suppressed - suppressedBefore >= 1,
  snapshot.observed.suppressed - suppressedBefore,
)
check(
  'a suppressed idle raised nothing',
  snapshot.observed.delivered - deliveredBefore === 2,
  snapshot.observed.delivered - deliveredBefore,
)

console.log('\nconfig-less row (the state a restart actually produces)')
// An id-targeted override later in the same patch file replaces the whole config,
// so after a restart the row can arrive with no config at all. The plugin must
// still load with its documented defaults.
listeners.clear()
reset()
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-attention-test-'))
let applied = true
try {
  apply(ctx, undefined)
  // The plugin defers its route registration, so let that tick run before the
  // route is used below.
  await new Promise((resolve) => setImmediate(resolve))
} catch (error) {
  applied = false
  check(`apply tolerates a missing config (${String(error)})`, false)
}
check('apply tolerates a missing config', applied)
const bare = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check('a config-less row falls back to documented defaults', bare.config.triggers.done === 'unfocused')
check('a config-less row keeps approval alerts on', bare.config.triggers.approval === 'always')
check('a config-less row keeps the minimum duration', bare.config.minDurationMs === 0)
check('a config-less row keeps every channel on', bare.config.channels.toast === true && bare.config.channels.sound === true)
check('a config-less row keeps the toast app id', bare.config.windows.appId === 'com.deepseek.dsh')

// The page reports visibility on every poll; without it the "unfocused" default
// deliberately stays silent, which is the conservative stance for an unattended
// deployment.
const reported = await callRoute('GET', '/api/attention-notifier/state?visible=0')
check('the visibility report is accepted', reported.parsed?.focus?.reported === true && reported.parsed.focus.visible === false)

const bareDone = agentFor('bare-1')
bareDone.toRunning()
// The defaults include a 30 s minimum, so the turn has to report a real duration.
emit('session/event', bareDone.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' }, durationMs: 60000 },
})
bareDone.toIdle()
await tick()
const afterBare = (await callRoute('GET', '/api/attention-notifier/state?visible=0')).parsed
check('a config-less row still raises alerts', calls.length === 1, `${String(calls.length)} raised`)
check('a config-less row reports the delivered count', afterBare.observed.delivered === 1, String(afterBare.observed.delivered))

console.log('\npage-contact counters')
// The only Host-side evidence that the browser half reached the page: the client
// polls this route, so a non-zero count proves the bundle loaded and ran.
check('page contact is counted', afterBare.client.seen >= 1, afterBare.client.seen)
check('the first contact time is recorded', afterBare.client.first > 0)
check('the last contact time is recorded', afterBare.client.last >= afterBare.client.first)
check('the visibility the page reported is echoed back', afterBare.client.lastVisible === false, String(afterBare.client.lastVisible))

console.log('\ninstant focus reporting')
// The page reports a visibility change as it happens, because minimizing the
// window finishes a turn well inside the poll interval: an idle decision reading a
// two-second-old "visible" would suppress the alert the user is waiting for.
const focusNow = await callRoute('POST', '/api/attention-notifier/focus?signals=visible%2Funfocused%2Faway', { visible: false })
check('the instant focus report is accepted', focusNow.status === 200)
const afterFocus = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check('the instant report is counted separately from the poll', afterFocus.client.focusReports === 1, afterFocus.client.focusReports)
check('the instant report updates focus state', afterFocus.focus.visible === false)
check('the instant report records the raw signals', afterFocus.focus.signals === 'visible/unfocused/away', String(afterFocus.focus.signals))
check('the instant report updates the contact marker', afterFocus.client.lastVisible === false)
const instantStatus = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'attention-notifier', 'status.json'), 'utf8'))
check('the instant report is persisted right away', instantStatus.focus.signals === 'visible/unfocused/away', String(instantStatus.focus.signals))

const focusBack = await callRoute('POST', '/api/attention-notifier/focus?signals=visible%2Ffocused%2Fpresent', { visible: true })
check('a return to focus is accepted', focusBack.status === 200)
const afterBack = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check('a return to focus flips the flag back', afterBack.focus.visible === true)
check('a return to focus records its own signals', afterBack.focus.signals === 'visible/focused/present', String(afterBack.focus.signals))

console.log('\nclient route probe')
// The page reports whether it can reach this plugin's route, because the Electron
// window is served over `dsh-app://` rather than over the Host's HTTP origin.
check('no probe result before the page reports one', afterBare.clientProbe.ok === null)
const probeReport = await callRoute(
  'GET',
  '/api/attention-notifier/client-probe-report?url=%2Fapi%2Fattention-notifier%2Fstate&ok=1&status=200&body=%7B%22ok%22%3Atrue%7D',
)
check('the probe report is accepted', probeReport.status === 200)
const probed = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check('the reported url is kept', probed.clientProbe.url === '/api/attention-notifier/state', String(probed.clientProbe.url))
check('the reported outcome is kept', probed.clientProbe.ok === true)
check('the reported status is kept', probed.clientProbe.status === 200, String(probed.clientProbe.status))
check('the reported body is kept', String(probed.clientProbe.body).includes('ok'))
check('the report time is recorded', probed.clientProbe.at > 0)

const failedProbe = await callRoute(
  'GET',
  '/api/attention-notifier/client-probe-report?url=%2Fapi%2Fattention-notifier%2Fstate&ok=0&error=Failed%20to%20fetch',
)
check('a failed probe is accepted too', failedProbe.status === 200)
const probedFail = (await callRoute('GET', '/api/attention-notifier/state')).parsed
check('a failed probe replaces the previous result', probedFail.clientProbe.ok === false)
check('the failure reason is kept', probedFail.clientProbe.error === 'Failed to fetch', String(probedFail.clientProbe.error))

console.log('\ndiagnostics document')
// Written on every page contact so the Host side can be inspected without a
// browser: the page is otherwise invisible from here.
const statusFile = join(process.env.DSH_HOME, 'attention-notifier', 'status.json')
check('the diagnostics document exists after a page contact', existsSync(statusFile))
let status
try {
  status = JSON.parse(readFileSync(statusFile, 'utf8'))
} catch (error) {
  check(`the diagnostics document parses (${String(error)})`, false)
}
check('it records the page contact count', status?.client?.seen >= 1, status?.client?.seen)
check('it records the probe outcome', status?.clientProbe?.ok === false, String(status?.clientProbe?.ok))
check('it records the platform', typeof status?.platform === 'string' && status.platform.length > 0)
check('it records whether delivery is available', typeof status?.delivery === 'boolean')
check('it records the observation counters', typeof status?.observed?.delivered === 'number')
check('it never records session content', !JSON.stringify(status).includes('session-'))

console.log('\nload marker')
// `apply` writes this on the next tick, deliberately keeping synchronous I/O out
// of the boot window the desktop shell waits on, so give it a turn first.
await new Promise((resolve) => setTimeout(resolve, 25))
const markerFile = join(process.env.DSH_HOME, 'attention-notifier', 'loaded.json')
check('apply writes the load marker', existsSync(markerFile))
let marker
try {
  marker = JSON.parse(readFileSync(markerFile, 'utf8'))
} catch (error) {
  check(`the load marker parses (${String(error)})`, false)
}
check('the marker records a timestamp', typeof marker?.at === 'number' && marker.at > 0)
check('the marker records the pid', typeof marker?.pid === 'number')
check('the marker reports whether a config arrived', typeof marker?.hasConfig === 'boolean')

console.log('\nboot-safety: registration is deferred past the boot window')
// The desktop shell shows a welcome window that calls into the Host as soon as it
// is up, and reports a startup failure when the Host is not ready in time. So the
// plugin must finish `apply` without doing the route registration or any
// synchronous disk write.
{
  listeners.clear()
  reset()
  route = undefined
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-attention-boot-'))
  const started = Date.now()
  apply(ctx, undefined)
  const applyMs = Date.now() - started
  check('apply itself returns promptly', applyMs < 50, applyMs)
  check('no route is registered synchronously', route === undefined)
  const markerPath = join(process.env.DSH_HOME, 'attention-notifier', 'loaded.json')
  check('no disk write happens synchronously', !existsSync(markerPath))
  await new Promise((resolve) => setImmediate(resolve))
  check('the route appears on the next tick', route !== undefined)
}

console.log('\nthe inApp channel gates the page queue')
// Regression: `inApp` used to be parsed but never consulted, so turning the in-app
// notice off left it appearing anyway - the page polls this queue and raises the
// notice from it, so the switch has to gate the queue itself.
await install({ minDurationMs: 0, channels: { toast: true, sound: true, inApp: false } })
const inAppOff = agentFor('s12e')
inAppOff.toRunning()
emit('session/event', inAppOff.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
inAppOff.toIdle()
await tick()
check('the toast still fires with inApp off', toasts().length === 1, toasts().length)
const queuedOff = (await callRoute('GET', '/api/attention-notifier/state?cursor=0')).parsed
check('nothing is queued for the page with inApp off', queuedOff.messages.length === 0, queuedOff.messages.length)

reset()
await install({ minDurationMs: 0, channels: { toast: true, sound: true, inApp: true } })
const inAppOn = agentFor('s12f')
inAppOn.toRunning()
emit('session/event', inAppOn.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
inAppOn.toIdle()
await tick()
const queuedOn = (await callRoute('GET', '/api/attention-notifier/state?cursor=0')).parsed
check('the message is queued for the page with inApp on', queuedOn.messages.length === 1, queuedOn.messages.length)
check('the queued message carries its text', typeof queuedOn.messages[0]?.title === 'string')

console.log('\nthe Plugins-page switch gates every alert')
// The switch edits `dsh.profile.bundles`; it cannot unload a running plugin. So the
// plugin reads that list per decision, which is what makes "off" mean off right away
// instead of at the next restart.
/** Write the profile's package.json listing exactly these bundles. */
function writeProfileBundles(bundles) {
  const dir = process.env.DSH_PROFILE_DIR
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles } } }),
    'utf8',
  )
}

// Switch ON: the profile lists the plugin, so an alert goes out.
reset()
await install({ minDurationMs: 0 })
writeProfileBundles(['dsh-attention-notifier'])
const switchedOn = agentFor('s12i')
switchedOn.toRunning()
emit('session/event', switchedOn.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
switchedOn.toIdle()
await tick()
check('an enabled plugin delivers', toasts().length === 1, toasts().length)

// Switch OFF: same running instance, profile no longer lists the plugin.
reset()
writeProfileBundles([])
const switchedOff = agentFor('s12j')
switchedOff.toRunning()
emit('session/event', switchedOff.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
switchedOff.toIdle()
await tick()
check('switching off silences the running instance', toasts().length === 0, toasts().length)
const offState = (await callRoute('GET', '/api/attention-notifier/state?cursor=0')).parsed
check('the switch state is published', offState.switch?.enabled === false, JSON.stringify(offState.switch))
check('the profile directory is published for diagnosis', offState.switch?.profileDir === process.env.DSH_PROFILE_DIR, String(offState.switch?.profileDir))

// Switch ON again: no restart, no reload.
reset()
writeProfileBundles(['dsh-attention-notifier'])
const switchedBack = agentFor('s12k')
switchedBack.toRunning()
emit('session/event', switchedBack.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
switchedBack.toIdle()
await tick()
check('switching back on resumes without a restart', toasts().length === 1, toasts().length)

console.log('\nunreadable switch state fails open')
// A plugin that silently stops notifying because it could not find a preference
// file is worse than one that notifies when the user expected silence.
reset()
await install({ minDurationMs: 0 })
rmSync(process.env.DSH_PROFILE_DIR, { recursive: true, force: true })
const noProfile = agentFor('s12l')
noProfile.toRunning()
emit('session/event', noProfile.session, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})
noProfile.toIdle()
await tick()
check('a missing profile still delivers', toasts().length === 1, toasts().length)

// `dsh-settings` describes every configuration entry by walking the schema and
// dereferencing node fields directly. The desktop welcome window calls
// `settings/describe` during startup, so a schema that throws there fails the whole
// boot with "desktop welcome: Web RPC failed" - which is exactly what a plain
// object without `meta` caused.
//
// This replicates that walk against the real Config, so the shape cannot regress.
{
  const { Config: LiveConfig, CONFIG_DEFAULTS: defaults } = await import('./config.js')
  check('Config has the node shape the walk needs', LiveConfig.type === 'object')
  check('Config carries meta, with volatile not required', LiveConfig.meta !== undefined)
  check('Config carries a dict of children', typeof LiveConfig.dict === 'object' && LiveConfig.dict !== null)

  // volatileForm: reads schema.meta.volatile and schema.type, recurses via dict.
  /**
   * Replica of dsh-settings' volatile-field selection.
   * @param schema - Schema node.
   * @returns A form node, or undefined when no field is live.
   */
  const volatileForm = (schema) => {
    if (schema.meta.volatile) return schema.toJSON()
    if (schema.type !== 'object') return undefined
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict }
  }

  // plainSchema: deletes node.meta.volatile and redacts node.meta.default.
  /**
   * Replica of dsh-settings' plain-schema walk.
   * @param node - JSON Schema node.
   */
  const walkPlain = (node) => {
    delete node.meta.volatile
    if (node.meta.default !== undefined) node.meta.default = node.meta.default
    for (const child of Object.values(node.dict ?? {})) walkPlain(child)
    if (node.inner) walkPlain(node.inner)
    for (const child of node.list ?? []) walkPlain(child)
  }

  try {
    const form = volatileForm(LiveConfig)
    check('the volatile walk does not throw', true)
    check('a schema without volatile fields yields no form', form === undefined, form)

    // projectForm: reads schema.dict for an object schema.
    const projectForm = (schema, value) => (schema.type === 'object' && value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => (value[key] === undefined
        ? []
        : [[key, projectForm(child, value[key])]])))
      : value)
    check('projectForm handles the defaults', projectForm(LiveConfig, defaults.minDurationMs) === defaults.minDurationMs)

    walkPlain(LiveConfig.toJSON())
    check('the plain-schema walk does not throw', true)
  } catch (error) {
    check(`the settings walk does not throw (${String(error)})`, false)
  }

  check('every child node is walkable', Object.values(LiveConfig.dict).every(
    (child) => child.meta !== undefined && typeof child.toJSON === 'function',
  ))
  check('toJSON produces a JSON Schema object', LiveConfig.toJSON().type === 'object')
  check('toJSON carries every field', Object.keys(LiveConfig.toJSON().properties).length === Object.keys(LiveConfig.dict).length)
}

console.log(`\n${String(pass)} passed, ${String(fail)} failed`)
process.exitCode = fail === 0 ? 0 : 1
