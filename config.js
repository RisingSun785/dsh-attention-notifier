/**
 * Config schema for the attention notifier.
 *
 * Two consumers read this object, and BOTH must be satisfied:
 *
 * 1. The Loader calls `Config['~standard'].validate(raw)` synchronously and
 *    expects `{ value }` or `{ issues }` (cordis `resolveConfig`).
 * 2. `dsh-settings` walks the schema while describing configuration, and it
 *    dereferences node fields directly: `volatileForm` reads `schema.meta.volatile`
 *    and `schema.type`, then recurses through `schema.dict`.
 *
 * The second consumer is what made the desktop shell fail to start. Its welcome
 * window asks the Host for `settings/describe`, that walk reached this schema, and
 * a plain object without `meta` threw
 * `TypeError: Cannot read properties of undefined (reading 'volatile')`. The whole
 * RPC rejected, and the shell reported `desktop welcome: Web RPC failed`.
 *
 * So every node here carries the Schemastery shape - `meta`, `type`, `dict`,
 * `toJSON()` - alongside the Standard Schema face. The plugin deliberately does not
 * depend on `@deepseek-ai/schemastery`, because that package ships with the DSH
 * installation and a `link:`-installed plugin cannot resolve it; this file builds
 * the same shape by hand.
 */

/** Accepted trigger modes, in presentation order. */
export const MODE_VALUES = ['off', 'unfocused', 'always']

/**
 * Accepted channel keys.
 *
 * A "taskbar flash" channel used to live here. It was removed rather than fixed:
 * the only mechanism reachable from a plugin is prefixing the document title, and
 * this application's window has no visible title bar, so the marker was never
 * rendered anywhere the user could see. Electron's real `win.flashFrame` needs the
 * window handle, which the Host half cannot obtain. A switch that cannot visibly
 * do anything is worse than no switch.
 */
const CHANNEL_KEYS = ['toast', 'sound', 'inApp']

/** Accepted trigger keys. */
const TRIGGER_KEYS = ['approval', 'question', 'done', 'error']

/** Documented defaults; also the value used when the row config omits a field. */
export const CONFIG_DEFAULTS = Object.freeze({
  triggers: Object.freeze({ approval: 'always', question: 'always', done: 'unfocused', error: 'always' }),
  minDurationMs: 0,
  channels: Object.freeze({ toast: true, sound: true, inApp: true }),
  restoreOnClick: true,
  rawFallback: false,
  windows: Object.freeze({
    appId: 'com.deepseek.dsh',
    toastTimeoutMs: 10000,
    soundTimeoutMs: 5000,
    focusTimeoutMs: 5000,
  }),
  external: Object.freeze([]),
})

/**
 * True when the value is a plain record.
 * @param value - Candidate.
 * @returns Whether it is a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build one leaf node in the shape `dsh-settings` walks.
 * @param json - JSON Schema fragment for the node.
 * @param extra - Extra Schemastery-shaped fields.
 * @returns A schema node.
 */
function leaf(json, extra = {}) {
  const meta = json.default === undefined ? {} : { default: json.default }
  return {
    type: json.type,
    meta,
    // The JSON projection carries `meta` at every level, because the settings walk
    // dereferences `node.meta.volatile` on each node it descends into.
    toJSON: () => ({ ...json, meta: { ...meta } }),
    ...extra,
  }
}

/**
 * Build an object node carrying child schemas in `dict`.
 *
 * `dict` is present on the JSON projection too, so a walk that descends through
 * `toJSON()` output finds the same children it would find on the live schema.
 *
 * @param properties - Child schemas keyed by field name.
 * @param json - JSON Schema fragment for this object.
 * @param defaults - Default value for this object, surfaced as `meta.default`.
 * @returns An object schema node.
 */
function group(properties, json, defaults) {
  const meta = { default: defaults }
  return {
    type: 'object',
    meta,
    dict: properties,
    toJSON: () => ({
      ...json,
      meta: { ...meta },
      dict: Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, child.toJSON()])),
    }),
  }
}

/**
 * Normalize one trigger-mode field.
 * @param value - Raw value.
 * @param fallback - Default.
 * @param path - Issue path.
 * @param issues - Collector for validation problems.
 * @returns A valid mode.
 */
function mode(value, fallback, path, issues) {
  if (value === undefined) return fallback
  if (typeof value === 'string' && MODE_VALUES.includes(value)) return value
  issues.push({ message: `expected one of ${MODE_VALUES.join(' | ')}`, path })
  return fallback
}

/**
 * Normalize one boolean field.
 * @param value - Raw value.
 * @param fallback - Default.
 * @param path - Issue path.
 * @param issues - Collector for validation problems.
 * @returns Boolean.
 */
function boolean(value, fallback, path, issues) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  issues.push({ message: 'expected a boolean', path })
  return fallback
}

/**
 * Normalize one numeric field.
 * @param value - Raw value.
 * @param fallback - Default.
 * @param path - Issue path.
 * @param issues - Collector for validation problems.
 * @param minimum - Lower bound; a smaller value is reported.
 * @returns Finite number within bounds.
 */
function number(value, fallback, path, issues, minimum = 0) {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isFinite(value) && value >= minimum) return value
  issues.push({ message: `expected a finite number >= ${String(minimum)}`, path })
  return fallback
}

/**
 * Normalize the full row config, applying defaults and reporting problems.
 * @param raw - The row's `config` value.
 * @returns Validated config with every field present, plus collected issues.
 */
function normalize(raw) {
  const issues = []
  const source = isRecord(raw) ? raw : {}
  const triggersRaw = isRecord(source.triggers) ? source.triggers : {}
  const channelsRaw = isRecord(source.channels) ? source.channels : {}
  const windowsRaw = isRecord(source.windows) ? source.windows : {}

  const triggers = {}
  for (const key of TRIGGER_KEYS) {
    triggers[key] = mode(triggersRaw[key], CONFIG_DEFAULTS.triggers[key], ['triggers', key], issues)
  }
  const channels = {}
  for (const key of CHANNEL_KEYS) {
    channels[key] = boolean(channelsRaw[key], CONFIG_DEFAULTS.channels[key], ['channels', key], issues)
  }
  let external = CONFIG_DEFAULTS.external
  if (source.external !== undefined) {
    if (Array.isArray(source.external)) external = source.external
    else issues.push({ message: 'expected an array', path: ['external'] })
  }
  const appId = typeof windowsRaw.appId === 'string' && windowsRaw.appId.length > 0
    ? windowsRaw.appId
    : CONFIG_DEFAULTS.windows.appId

  return {
    value: {
      triggers,
      channels,
      external,
      appId,
      minDurationMs: number(source.minDurationMs, CONFIG_DEFAULTS.minDurationMs, ['minDurationMs'], issues),
      restoreOnClick: boolean(source.restoreOnClick, CONFIG_DEFAULTS.restoreOnClick, ['restoreOnClick'], issues),
      rawFallback: boolean(source.rawFallback, CONFIG_DEFAULTS.rawFallback, ['rawFallback'], issues),
      windows: {
        appId,
        toastTimeoutMs: number(
          windowsRaw.toastTimeoutMs,
          CONFIG_DEFAULTS.windows.toastTimeoutMs,
          ['windows', 'toastTimeoutMs'],
          issues,
          1000,
        ),
        soundTimeoutMs: number(
          windowsRaw.soundTimeoutMs,
          CONFIG_DEFAULTS.windows.soundTimeoutMs,
          ['windows', 'soundTimeoutMs'],
          issues,
          1000,
        ),
        focusTimeoutMs: number(
          windowsRaw.focusTimeoutMs,
          CONFIG_DEFAULTS.windows.focusTimeoutMs,
          ['windows', 'focusTimeoutMs'],
          issues,
          1000,
        ),
      },
    },
    issues,
  }
}

/** Child schemas for `triggers`. */
const triggerDict = Object.fromEntries(
  TRIGGER_KEYS.map((key) => [key, leaf({ type: 'string', enum: [...MODE_VALUES], default: CONFIG_DEFAULTS.triggers[key] })]),
)

/** Child schemas for `channels`. */
const channelDict = Object.fromEntries(
  CHANNEL_KEYS.map((key) => [key, leaf({ type: 'boolean', default: CONFIG_DEFAULTS.channels[key] })]),
)

/** Child schemas for `windows`. */
const windowDict = {
  appId: leaf({ type: 'string', default: CONFIG_DEFAULTS.windows.appId }),
  toastTimeoutMs: leaf({ type: 'number', minimum: 1000, default: CONFIG_DEFAULTS.windows.toastTimeoutMs }),
  soundTimeoutMs: leaf({ type: 'number', minimum: 1000, default: CONFIG_DEFAULTS.windows.soundTimeoutMs }),
  focusTimeoutMs: leaf({ type: 'number', minimum: 1000, default: CONFIG_DEFAULTS.windows.focusTimeoutMs }),
}

/**
 * The documented defaults as a standalone object.
 *
 * The plugin needs these when a row carries no config at all, which is a real
 * state: an id-targeted override later in the same patch file replaces a row's
 * whole `config`, so after a restart a row can legitimately arrive empty.
 * @returns A fresh, fully populated config.
 */
export function defaultConfig() {
  return normalize(undefined).value
}

/**
 * The plugin's Config.
 *
 * Carries both faces described at the top of this file: the Standard Schema
 * `~standard.validate` that the Loader calls, and the Schemastery node shape
 * (`meta` / `type` / `dict` / `toJSON`) that `dsh-settings` walks.
 */
export const Config = {
  type: 'object',
  meta: { default: CONFIG_DEFAULTS },
  dict: {
    triggers: group(triggerDict, {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        TRIGGER_KEYS.map((key) => [key, { type: 'string', enum: [...MODE_VALUES], default: CONFIG_DEFAULTS.triggers[key] }]),
      ),
    }, CONFIG_DEFAULTS.triggers),
    minDurationMs: leaf({ type: 'number', minimum: 0, default: CONFIG_DEFAULTS.minDurationMs }),
    channels: group(channelDict, {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        CHANNEL_KEYS.map((key) => [key, { type: 'boolean', default: CONFIG_DEFAULTS.channels[key] }]),
      ),
    }, CONFIG_DEFAULTS.channels),
    restoreOnClick: leaf({ type: 'boolean', default: CONFIG_DEFAULTS.restoreOnClick }),
    rawFallback: leaf({ type: 'boolean', default: CONFIG_DEFAULTS.rawFallback }),
    windows: group(windowDict, {
      type: 'object',
      additionalProperties: false,
      properties: {
        appId: { type: 'string', default: CONFIG_DEFAULTS.windows.appId },
        toastTimeoutMs: { type: 'number', minimum: 1000, default: CONFIG_DEFAULTS.windows.toastTimeoutMs },
        soundTimeoutMs: { type: 'number', minimum: 1000, default: CONFIG_DEFAULTS.windows.soundTimeoutMs },
        focusTimeoutMs: { type: 'number', minimum: 1000, default: CONFIG_DEFAULTS.windows.focusTimeoutMs },
      },
    }, CONFIG_DEFAULTS.windows),
    external: leaf({ type: 'array', default: [] }),
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-attention-notifier',
    /**
     * Validate and default a row config.
     * @param raw - The row's `config` value.
     * @returns `{ value }` when valid, otherwise `{ issues }`.
     */
    validate(raw) {
      const { value, issues } = normalize(raw)
      return issues.length === 0 ? { value } : { issues }
    },
  },
  /**
   * JSON Schema projection, matching what `Schemastery.prototype.toJSON` returns.
   *
   * `meta` is present at the root as well: `dsh-settings` deletes
   * `node.meta.volatile` on the top node first, so a projection without it throws
   * before descending.
   * @returns JSON Schema for this config.
   */
  toJSON() {
    return {
      type: 'object',
      additionalProperties: false,
      meta: { ...this.meta },
      properties: Object.fromEntries(Object.entries(this.dict).map(([key, child]) => [key, child.toJSON()])),
    }
  },
}
