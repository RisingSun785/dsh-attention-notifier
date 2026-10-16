/**
 * Throwaway loader hook: redirect the Host half's Windows delivery module to a
 * recorder so the plugin's real decision logic can be exercised without spawning
 * PowerShell or displaying anything.
 *
 * Loader hooks run on their own thread, so the redirect target is a constant here
 * rather than registration data.
 */
import { pathToFileURL } from 'node:url'

const BASE = 'D:/dsh/AppData/default-workspace/attention-notifier'

/** Absolute file URL of the module that must be replaced. */
const REAL = pathToFileURL(`${BASE}/win32.js`).href

/** Absolute file URL of the recorder that replaces it. */
const STUB = pathToFileURL(`${BASE}/_delivery_stub.mjs`).href

/**
 * Rewrite the delivery module's resolution to the recorder.
 * @param specifier - Requested specifier.
 * @param context - Resolution context.
 * @param nextResolve - Default resolver.
 * @returns The redirected or default resolution.
 */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (resolved.url === REAL || resolved.url.endsWith('/attention-notifier/win32.js')) {
    return { ...resolved, url: STUB, shortCircuit: true }
  }
  return resolved
}
