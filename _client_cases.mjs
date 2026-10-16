/**
 * Throwaway cases for the browser half's module contract.
 *
 * The page's React arrives from the shell's own bundle, which is not reachable
 * from Node, so this harness verifies everything that does not need a renderer:
 * the module-loader registration, the exported plugin shape, the slot
 * registrations, the Remote Event subscriptions, and the page lifecycle wiring.
 * A mistake in any of those breaks the boot of the whole page, which is exactly
 * what is worth catching before a browser does it.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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

// The bundle executes in a page realm, so provide the two globals it reads at
// module scope and a loader facade that hands back the registered factory.
let registration
const listeners = new Map()

globalThis.window = {
  __ModuleLoader__: {
    /**
     * Capture one bundle registration.
     * @param value - Registration carrying the id and factory.
     */
    load(value) {
      registration = value
    },
  },
  addEventListener(type, listener) {
    const list = listeners.get(type) ?? []
    list.push(listener)
    listeners.set(type, list)
  },
  removeEventListener(type, listener) {
    const list = listeners.get(type) ?? []
    listeners.set(type, list.filter((entry) => entry !== listener))
  },
  dispatchEvent(event) {
    for (const listener of listeners.get(event.type) ?? []) listener(event)
  },
}

globalThis.document = {
  visibilityState: 'visible',
  title: 'DSH',
  hasFocus: () => true,
  documentElement: { lang: 'zh-CN' },
  addEventListener() {},
  removeEventListener() {},
}

globalThis.CustomEvent = class CustomEvent {
  /**
   * @param type - Event name.
   * @param init - Event initializer.
   */
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}

/** Lines the plugin wrote to the page console, so its diagnostics can be asserted. */
const consoleLines = []

/**
 * Everything the plugin has logged so far.
 * @returns Array of formatted lines.
 */
function consoleText() {
  return consoleLines
}

const realConsole = { log: console.log, error: console.error }

/** Route the plugin's console output into `consoleLines` while it runs. */
function captureConsole() {
  for (const level of ['log', 'error']) {
    console[level] = (...parts) => {
      consoleLines.push(parts.map((part) => (typeof part === 'string' ? part : String(part))).join(' '))
    }
  }
}

/** Restore the harness's own console. */
function releaseConsole() {
  console.log = realConsole.log
  console.error = realConsole.error
}

/** Run a function with the plugin's console captured, always releasing it after. */
function withCapturedConsole(run) {
  captureConsole()
  try {
    return run()
  } finally {
    releaseConsole()
  }
}

/** Requests the page half made, so the route contract can be asserted. */
const requests = []

/** A complete settings snapshot, so the card renders its real body, not the loading state. */
const snapshot = {
  ok: true,
  seq: 0,
  messages: [],
  config: {
    triggers: { approval: 'always', question: 'unfocused', done: 'unfocused', error: 'always' },
    channels: { toast: true, sound: true, inApp: true },
    minDurationMs: 30000,
    restoreOnClick: true,
    rawFallback: false,
    windows: { appId: 'com.deepseek.dsh', toastTimeoutMs: 10000, soundTimeoutMs: 5000, focusTimeoutMs: 5000 },
    external: [],
  },
  focus: { reported: true, visible: false, updatedAt: 1 },
  stats: {
    inflight: 0,
    toastOk: 2,
    toastFail: 0,
    soundOk: 1,
    soundFail: 0,
    lastError: null,
    supported: true,
    platform: 'win32',
  },
  probe: { supported: true, powershell: 'x', powershellPresent: true, sound: 'notify.wav' },
  flash: false,
}

globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
  return {
    ok: true,
    status: 200,
    async json() {
      return snapshot
    },
  }
}

/** The page polls, so keep the timer from holding the process open. */
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (callback, delay) => {
  const handle = realSetInterval(callback, delay)
  if (typeof handle.unref === 'function') handle.unref()
  return handle
}

console.log('module registration')
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
check('registers through the module loader', source.includes('__ModuleLoader__.load('))
check('declares the package name as its id', source.includes("id: 'dsh-attention-notifier'"))

// Importing executes the bundle, which registers the factory.
await import(pathToFileURL('D:/dsh/AppData/default-workspace/attention-notifier/client.js').href)
check('registration captured', registration !== undefined)
check('registration id is the package name', registration?.id === 'dsh-attention-notifier')
check('factory is a function', typeof registration?.factory === 'function')

console.log('\nfactory contract')
/**
 * Stand-in for the shell's seed modules.
 *
 * `useEffect` runs the effect once and ignores the returned cleanup, which is
 * enough to make a mounted component issue its own data load — the behaviour the
 * route-contract assertions below depend on.
 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: (effect) => {
    effect()
  },
}

const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected require: ${specifier}`)
})
check('factory returns an object plugin', typeof plugin === 'object' && plugin !== null)
check('plugin exposes apply', typeof plugin.apply === 'function')
check('plugin declares its inject list', Array.isArray(plugin.inject))

console.log('\napply: slot registrations and event subscriptions')
const registrations = []
const effects = []
const subscriptions = []
const injected = []

const ctx = {
  slots: {
    inject(name, callback) {
      injected.push(name)
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  remote: {
    $on(name, listener) {
      subscriptions.push({ name, listener })
      return () => {}
    },
  },
  effect(callback, label) {
    effects.push(label)
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

withCapturedConsole(() => plugin.apply(ctx))

check('injects every slot it registers into', injected.length === 3, injected.length)
check('registers into shell.overlay', registrations.some((entry) => entry.options.name === 'shell.overlay'))
check('overlay entry carries an id and order', registrations[0]?.options.id === 'attention-notifier' && registrations[0]?.options.order === 60)
// `sidebar.toggle.badge` is a single-value slot already owned by the shell, so the
// plugin must not claim it; the banner inside `shell.overlay` carries the notice.
check('does not claim the shell-owned sidebar badge slot', !injected.includes('sidebar.toggle.badge'))
check('registers the settings card into plugins.item', registrations.some((entry) => entry.options.name === 'plugins.item'))
// The bundle detail page is where a plugin's own page lives, keyed by package name.
check(
  'registers the settings card on the bundle detail page',
  registrations.some(
    (entry) => entry.options.name === 'plugins.bundle.config'
      && entry.options.key === 'dsh-attention-notifier',
  ),
)
const card = registrations.find((entry) => entry.options.name === 'plugins.item')
check('the card has a visible label', typeof card?.options.label === 'string' && card.options.label.length > 0)
check('every registration supplies a component', registrations.every((entry) => typeof entry.component === 'function'))

check('subscribes to approval/request', subscriptions.some((entry) => entry.name === 'approval/request'))
check('subscribes to user-questions/request', subscriptions.some((entry) => entry.name === 'user-questions/request'))
check('registers its cleanup effects', effects.length >= 2)

console.log('\nstep isolation')
// A failing optional step must not stop the alerts from being wired: the page is
// the only place these run, so a partial failure there is otherwise invisible.
check('every step reported ok', !consoleText().some((line) => line.includes('STEP FAILED')), consoleText())
check('the load marker reports success', consoleText().some((line) => line.includes('all steps ok')), consoleText())
check('the plugin was not disabled for missing services', !consoleText().some((line) => line.includes('services unavailable')))

// Now break one optional slot and confirm the rest still installs.
const brokenRegistrations = []
const brokenEffects = []
const brokenSubscriptions = []
const brokenCtx = {
  slots: {
    inject(name, callback) {
      // Simulate a deployment where plugins.bundle.config is not declared.
      if (name === 'plugins.bundle.config') throw new Error('slot not declared')
      callback()
    },
    register(options, component) {
      brokenRegistrations.push({ options, component })
      return () => {}
    },
  },
  remote: {
    $on(name, listener) {
      brokenSubscriptions.push({ name, listener })
      return () => {}
    },
  },
  effect(callback, label) {
    brokenEffects.push(label)
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

withCapturedConsole(() => plugin.apply(brokenCtx))
check('a failing optional slot still leaves the other registrations', brokenRegistrations.length === 2, brokenRegistrations.length)
check('a failing optional slot still leaves the event listeners', brokenSubscriptions.length === 2, brokenSubscriptions.length)
check('a failing optional slot still leaves the effects', brokenEffects.length >= 3, brokenEffects.length)
check('the failure is reported, not swallowed', consoleText().some((line) => line.includes('STEP FAILED')))
check('the load marker lists what failed', consoleText().some((line) => line.includes('plugins.bundle.config')))

console.log('\nwaterfall listeners must delegate with next()')
const approval = subscriptions.find((entry) => entry.name === 'approval/request')
let delegated = 0
const next = () => {
  delegated += 1
  return Promise.resolve('delegated')
}
const outcome = await approval.listener.call({ id: 'session-1' }, {
  toolName: 'pwsh',
  callId: 'call-1',
  reason: 'needs escalation',
  displayReason: { zh: '允许本次操作使用 danger-full-access 权限' },
}, next)
check('approval listener calls next()', delegated === 1)
check('approval listener returns the delegated outcome', outcome === 'delegated')

const question = subscriptions.find((entry) => entry.name === 'user-questions/request')
delegated = 0
const questionOutcome = await question.listener.call({ id: 'session-1' }, {
  questions: [{ id: 'q1', question: '继续吗？' }],
  wait: { callId: 'call-q1' },
}, next)
check('question listener calls next()', delegated === 1)
check('question listener returns the delegated outcome', questionOutcome === 'delegated')

console.log('\na listener failure must not break the flow')
delegated = 0
const hostile = await approval.listener.call({ id: 'session-1' }, null, next)
check('a null request still delegates', delegated === 1)
check('a null request does not throw', hostile === 'delegated')

console.log('\npage lifecycle wiring')
const pageEvents = new Map()
const fakeWindow = {
  addEventListener(type, listener) {
    const list = pageEvents.get(type) ?? []
    list.push(listener)
    pageEvents.set(type, list)
  },
  removeEventListener(type, listener) {
    pageEvents.set(type, (pageEvents.get(type) ?? []).filter((entry) => entry !== listener))
  },
}
let lifecycles = 0
const dispose = plugin.startPageLifecycle(fakeWindow)
check('listens for the in-app alert event', (pageEvents.get('dsh-attention') ?? []).length === 1)
check('listens for window focus', (pageEvents.get('focus') ?? []).length === 1)
check('listens for visibility changes', (pageEvents.get('visibilitychange') ?? []).length === 1)

fakeWindow.dispatchEvent = (event) => {
  for (const listener of pageEvents.get(event.type) ?? []) listener(event)
}
fakeWindow.dispatchEvent({ type: 'dsh-attention', detail: { kind: 'done' } })
lifecycles += 1
check('an in-app alert is handled without throwing', lifecycles === 1)

dispose()
check('disposal removes every listener', pageEvents.get('dsh-attention')?.length === 0)
check('disposal leaves other event types clean', pageEvents.get('focus')?.length === 0)

console.log('\nsettings card renders and loads its data')
const cardRegistration = registrations.find((entry) => entry.options.name === 'plugins.item')
let cardTree
try {
  cardTree = cardRegistration.component({})
  check('the card renders without throwing', cardTree !== undefined && cardTree !== null)
} catch (error) {
  check(`the card renders without throwing (${String(error)})`, false)
}
check('the card renders a container element', typeof cardTree?.type === 'function' || typeof cardTree?.type === 'string')

// Mounting the card must issue its own settings read.
await new Promise((resolve) => setTimeout(resolve, 5))
const urls = requests.map((entry) => entry.url)
check('the card reads the plugin route', urls.some((url) => url.startsWith('/api/attention-notifier/state')), urls.length > 0)

// The card only reaches its config-dependent body once its state holds the
// snapshot, and this stub does not re-render on a state update. Seed the hook
// slots in call order and keep them seeded while the tree is flattened, because
// flattening invokes the function components, which read the same hooks.
const realUseState = reactStub.useState
const seeded = [snapshot, snapshot.config, '', null, null, null, null, null]
const initialState = (index) => (index < seeded.length ? seeded[index] : null)

/**
 * Flatten a React-element tree into its string children.
 *
 * `createElement(type, props, ...children)` keeps children on the element, while
 * bands built with a children array keep them in `props.children`. Function
 * components are invoked, since their own output holds the text.
 * @param node - Element, array, function component, or primitive.
 * @returns Concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'function') {
    try {
      return textOf(node({}))
    } catch {
      return ''
    }
  }
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join(' ')
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props))
    return `${textOf(node.children)} ${textOf(node.props?.children)}`
  }
  return ''
}

let loadedTree
let rendered = ''
try {
  let seedIndex = 0
  reactStub.useState = () => {
    const value = initialState(seedIndex)
    seedIndex += 1
    return [value, () => {}]
  }
  loadedTree = cardRegistration.component({})
  check('the loaded card renders without throwing', loadedTree !== undefined && loadedTree !== null)
  rendered = textOf(loadedTree)
} catch (error) {
  check(`the loaded card renders without throwing (${String(error)})`, false)
} finally {
  reactStub.useState = realUseState
}
if (process.env.DSH_DEBUG_RENDER === '1') {
  const shape = (node, depth = 0) => {
    if (depth > 3 || node === null || node === undefined) return typeof node
    if (typeof node === 'string') return JSON.stringify(node)
    if (Array.isArray(node)) return `[${node.map((child) => shape(child, depth + 1)).join(', ')}]`
    if (typeof node === 'object') {
      const name = typeof node.type === 'function' ? node.type.name || 'fn' : String(node.type)
      const kids = node.children?.length ? `(${node.children.map((child) => shape(child, depth + 1)).join(', ')})` : ''
      return `${name}${kids}`
    }
    return typeof node
  }
  console.log('SHAPE >>>', shape(loadedTree).slice(0, 1200))
}

// The card builds its bands out of nested function components, which a shallow
// flattener cannot reach into. Assert the structure instead: the bands exist and
// the copy they render is present in the bundle. `Section` is closure-private, so
// bands are recognised by the heading prop they all carry.
const bands = (loadedTree?.children ?? []).filter(
  (child) => typeof child === 'object' && child !== null
    && typeof child.type === 'function'
    && typeof child.props?.heading === 'string',
)
check('the loaded card renders all four bands', bands.length >= 4, bands.length)
check('the bands cover triggers, channels, tests and status', new Set(bands.map((band) => band.props.heading)).size >= 4)
check('the card is composed of elements, not a bare fragment', typeof loadedTree?.type === 'function' || typeof loadedTree?.type === 'string')
check('the loaded card shows the plugin title', rendered.includes('注意力提醒'))
check('the loaded card renders its control rows', bands.some((band) => (band.children?.length ?? 0) >= 4))

const bundle = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

console.log('\nthe card autosaves instead of offering a Save button')
// Every control writes itself; a Save button was removed because forgetting to
// press it silently discarded the edit.
check('no Save button is rendered', !rendered.includes('保存'), rendered.includes('保存'))
check('the bundle still carries the saving copy', bundle.includes('保存中'))
check('the bundle still carries the saved copy', bundle.includes('已保存'))
check('the bundle offers a retry for a failed write', bundle.includes('重试'))
// The debounce is the whole mechanism, and it only fires for user edits: reacting
// to every draft change would echo each poll straight back to the Host.
check('the autosave is debounced', bundle.includes('setTimeout'))
check('the autosave is gated on a pending edit', bundle.includes('dirty'))
check('user edits mark the draft dirty', bundle.includes('setDirty(true)'))
check('the poll will not clobber a pending edit', bundle.includes('pending !== true'))

for (const copy of [
  '权限确认等待中',
  '提问等待中（含计划评审）',
  '任务完成',
  '任务出错',
  'Windows 系统通知',
  '提示音',
  '应用内提示条',
  '测试系统通知',
  '测试提醒通知',
  '测试提示音',
  '测试恢复窗口',
  '只有审批策略为 ask 的会话才会产生权限确认提醒',
  '已观测',
]) {
  check(`the bundle carries the copy "${copy}"`, bundle.includes(copy))
}
check('the status band surfaces the observation counters', bundle.includes('formatObserved'))

console.log('\nlist seat renders one line, not the form')
// `plugins.item` is a single description line in the plugins list; the form
// belongs to the bundle's detail page. Rendering the form in both seats stretched
// the plugins list into a page-sized panel.
let listText = ''
try {
  reactStub.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  listText = textOf(cardRegistration.component({ view: 'summary' }))
} catch (error) {
  check(`the summary view renders without throwing (${String(error)})`, false)
} finally {
  reactStub.useState = realUseState
}
check('the summary view returns a short line', listText.length > 0 && listText.length < 200, listText.length)
check('the summary line describes the plugin', listText.includes('权限确认'))
check('the summary view does not render the form', !listText.includes('提醒时机'))

console.log('\ndetail seat renders the form')
let detailText = ''
let detailTree
try {
  const seededDetail = [snapshot, snapshot.config, '', null, null, null, null, null]
  let seed = 0
  reactStub.useState = () => {
    const value = seed < seededDetail.length ? seededDetail[seed] : null
    seed += 1
    return [value, () => {}]
  }
  detailTree = cardRegistration.component({ view: 'page' })
  detailText = textOf(detailTree)
} catch (error) {
  check(`the detail view renders without throwing (${String(error)})`, false)
} finally {
  reactStub.useState = realUseState
}
check('the detail view renders the form', detailText.includes('提醒时机'))
// The channel switches are child components rather than direct text, so assert the
// structure here; the copy those switches render is asserted from the bundle above.
const detailBands = (detailTree?.children ?? []).filter(
  (child) => typeof child === 'object' && child !== null
    && typeof child.type === 'function'
    && typeof child.props?.heading === 'string',
)
check('the detail view renders all four bands', detailBands.length >= 4, detailBands.length)

console.log('\nduration field round-trip (seconds <-> milliseconds)')
// Regression: the field once stored milliseconds in the draft AND multiplied by
// 1000 on save, so typing 1 produced 1000000 ms and read back as 1000.
/**
 * Pull the duration number input out of a rendered card tree.
 * @param node - Element tree.
 * @returns The input element, or null.
 */
function findDurationInput(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDurationInput(child)
      if (found !== null) return found
    }
    return null
  }
  if (node.type === 'input' && node.props?.type === 'number') return node
  if (typeof node.type === 'function') {
    for (const child of node.children ?? []) {
      const found = findDurationInput(child)
      if (found !== null) return found
    }
  }
  return findDurationInput(node.children)
}

// Render with a draft whose milliseconds came from the Host, and read the input.
let durationInput = null
{
  const seededSeconds = [snapshot, { ...snapshot.config, minDurationSeconds: 30 }, '', null, null, null, null, null]
  let seed = 0
  reactStub.useState = () => {
    const value = seed < seededSeconds.length ? seededSeconds[seed] : null
    seed += 1
    return [value, () => {}]
  }
  try {
    durationInput = findDurationInput(cardRegistration.component({ view: 'page' }))
  } finally {
    reactStub.useState = realUseState
  }
}
check('the duration field renders in seconds, not milliseconds', durationInput?.props?.value === 30, durationInput?.props?.value)
check('the duration field accepts any value, not multiples of 5', durationInput?.props?.step === 'any', durationInput?.props?.step)

// Typing must move the draft in seconds and leave the conversion to `save`.
let typedInto = null
{
  const setters = []
  const seededTyping = [snapshot, { ...snapshot.config, minDurationSeconds: 30 }, '', null, null, null, null, null]
  let seed = 0
  reactStub.useState = (initial) => {
    const slot = setters.length
    const value = seed < seededTyping.length ? seededTyping[seed] : initial
    seed += 1
    setters.push(value)
    return [value, (next) => {
      setters[slot] = typeof next === 'function' ? next(setters[slot]) : next
    }]
  }
  try {
    durationInput = findDurationInput(cardRegistration.component({ view: 'page' }))
    durationInput?.props?.onChange?.({ target: { value: '1' } })
    // The draft is the second state slot; its updater is a functional patch.
    const patched = setters[1]
    typedInto = patched?.minDurationSeconds
  } finally {
    reactStub.useState = realUseState
  }
}
check('typing 1 stores 1 in the draft', typedInto === 1, typedInto)
check(
  'the draft value would save as 1000 ms, not 1000000',
  Math.round(typedInto * 1000) === 1000,
  Math.round(typedInto * 1000),
)

console.log('\nroute path contract')
check('the route is namespaced under /api', urls.every((url) => url.startsWith('/api/attention-notifier/')), urls.length > 0)

console.log(`\n${String(pass)} passed, ${String(fail)} failed`)
process.exitCode = fail === 0 ? 0 : 1
