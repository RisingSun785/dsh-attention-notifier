/**
 * Test entry for the Host half.
 *
 * Runs two phases in one process:
 *   1. the real Windows delivery layer, probed for capability (no notification is
 *      displayed and no sound is played);
 *   2. the state-machine suite, with that layer redirected to a recorder.
 *
 * Run with: node ./_statemachine.mjs
 */
import { register } from 'node:module'
import { existsSync } from 'node:fs'
import { probe } from './win32.js'

let capabilityPass = 0
let capabilityFail = 0
/**
 * Assert one capability expectation.
 * @param label - What is being checked.
 * @param condition - Expected outcome.
 */
function capability(label, condition) {
  if (condition) {
    capabilityPass += 1
    console.log(`  PASS  ${label}`)
  } else {
    capabilityFail += 1
    console.log(`  FAIL  ${label}`)
  }
}

console.log('delivery capability (nothing is displayed or played)')
const caps = probe()
capability(`the platform supports delivery (${String(caps.supported)})`, caps.supported)
capability('PowerShell is present', caps.powershellPresent)
capability(`a notification sound resolves (${String(caps.sound)})`, caps.sound !== null)
// The registry value renders as `(Default) REG_SZ "C:\…\app.exe" "%1"`, and this
// installation's path contains a space, which a whitespace-anchored pattern misses.
capability(
  `the app executable resolves for "restore window" (${String(caps.appExe)})`,
  caps.appExe !== null,
)
capability('the resolved executable exists on disk', caps.appExe !== null && existsSync(caps.appExe))
console.log('')

register(new URL('./_loader.mjs', import.meta.url), { parentURL: import.meta.url })

await import('./_cases.mjs')

if (capabilityFail > 0) {
  console.error(`\n${String(capabilityFail)} capability check(s) failed`)
  process.exitCode = 1
}
