/** Throwaway recorder standing in for win32.js during state-machine tests. */

/** Every delivery attempt the plugin made. */
export const calls = []

/** The toast options of the most recent attempt, mirroring win32.js's diagnostic. */
let lastOptions

export function reset() {
  calls.length = 0
  lastOptions = undefined
}

export function isSupported() {
  return true
}

export function probe() {
  return { supported: true, powershell: 'stub', powershellPresent: true, sound: 'stub.wav', appExe: 'stub.exe' }
}

/**
 * The options the plugin passed to the most recent toast, mirroring
 * `win32.js`'s diagnostic export so the plugin's import resolves here too.
 * @returns The last options, or undefined before the first toast.
 */
export function lastToastXml() {
  return lastOptions === undefined ? undefined : JSON.stringify(lastOptions)
}

export async function showToast(options) {
  lastOptions = options
  calls.push({
    kind: 'toast',
    title: options.title,
    body: options.body,
    sound: options.sound === true,
    raw: options.raw === true,
    focusAction: options.focusAction === true,
  })
  return { ok: true }
}

export async function playSound() {
  calls.push({ kind: 'sound' })
  return { ok: true }
}

export async function focusWindow() {
  calls.push({ kind: 'focus' })
  return { ok: true }
}
