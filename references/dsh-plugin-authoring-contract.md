# DSH third-party plugin contract — evidence-backed reference

Sources (all read directly, this session):

- Extracted runtime: `C:\Users\Administrator\AppData\Local\Temp\dsh-asar-x\ex\dsh\node_modules\@deepseek-ai\...` (lib/*.js + package.json + README.md only)
- Full app archive (read with a small ASAR reader I wrote at `C:\Users\Administrator\AppData\Local\Temp\dsh-asar-x\asar-dump.mjs`):
  `D:\dsh\AppData\DeepSeek Harness\resources\app.asar` → inner paths `/dsh/node_modules/@deepseek-ai/<pkg>/...`
  (the bundle `cordis.patch.yml` files and the in-repo authoring skill are **not** in the temp extraction)
- Profile: `C:\Users\Administrator\.dsh\profiles\desktop\` (`cordis.yml`, `cordis.patch.yml`, `package.json`, `pnpm-workspace.yaml`)
- A real third-party plugin installed in another profile: `C:\Users\Administrator\.dsh\profiles\market\node_modules\dshmarket\` (with full `src/*.ts`)

---

## 1. Minimal on-disk layout of a DSH plugin package

A DSH plugin is an ordinary **Cordis plugin package** plus an optional **bundle patch** that inserts its
Loader row. Two shapes, both real:

### 1a. Host-only `apply` plugin (no build tool, no deps) — minimal layout

The in-repo authoring skill (`/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`,
lines 5-27) states the minimal manifest verbatim:

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

### 1b. Real compiled example — `@deepseek-ai/dsh-tool-present`

`...\@deepseek-ai\dsh-tool-present\lib\index.js` (whole file, 124 lines; exports at line 124):

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
/** Stable Loader identity. */
const name = "tool-present";
/** Validated delivery limit. */
const Config = z.object({ maxFiles: z.number().default(8) });
/** Services used by the scoped delivery tool. */
const inject = ["tools", "fs", "sessionProjections"];
/** @param ctx - agent-scoped services. @param config - maximum files per call. */
function apply(ctx, config) {
  if (!Number.isSafeInteger(config.maxFiles) || config.maxFiles < 1)
    throw new Error("present requires a positive integer maxFiles");
  ctx.tools.register(defineTool({ name: "present", /* ... */ }));
  ctx.on("tools/result", (exec, result) => { /* ... */ });
}
export { Config, apply, inject, name };
```

So the export set is exactly: `name` (string), `Config` (schema), `inject` (array), `apply(ctx, config)`.
All four are **named exports**; no default export.

### 1c. Second supported form — a `Service` class as default export

`...\@deepseek-ai\dsh-user-approval\lib\index.js`:

```js
var ApprovalService = class extends Service {
  config;
  static Config = z.object({ policy: z.union(["ask", "never"]).default("ask") });
  constructor(ctx, config) { super(ctx, "approval"); this.config = config; /* ... */ }
  /* ... */
};
export { APPROVAL_POLICIES, ApprovalRequestId, ApprovalService, ApprovalService as default, setApprovalPolicy };
```

### 1d. What the Loader actually accepts (exact code)

- `...\@deepseek-ai\cordis-plugin-loader\lib\index.js` lines 448-462 (`_init`) imports the module and calls
  `this.loader.unwrapExports(exports)`; lines 663-669:
  ```js
  unwrapExports(exports) {
    if (isNullable(exports)) return exports;
    exports = exports.default ?? exports;      // a default export WINS
    if (!exports.__esModule) return exports;
    return exports.default ?? exports;
  }
  ```
- `...\@deepseek-ai\cordis\lib\index.js` lines 1619-1641:
  ```js
  plugin(plugin, config, getOuterStack) {
    const callback = this.resolve(plugin);            // function | { apply }
    let name = plugin.name; if (name === "apply") name = void 0;
    runtime = { name, callback, fibers, Config: plugin.Config };
    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
  }
  ```
  `isApplicable(object)` (line 1446) = `typeof object.apply === "function"`.
  For a namespace object, `plugin.name/apply/Config/inject` are read off the module namespace,
  i.e. `export const name`, `export function apply`, `export const Config`, `export const inject`.
  **Do not mix** the two forms (skill: "index.js exports one of these forms; do not mix them").

### 1e. `apply(ctx, config)` arguments

- `ctx` — the plugin's Cordis `Context` (fiber-scoped); DSH adds services onto it (`ctx.tools`, `ctx.fs`,
  `ctx.sessionProjections`, … the names listed in `inject`). Register everything inside `apply` with
  `ctx.effect(...)`/`ctx.on(...)` and return the cleanup (skill host-plugin.md line 54).
- `config` — the row's `config`, **validated and defaulted** by `Config` before `apply` runs.
  Validation lives in `...\@deepseek-ai\cordis\lib\index.js` lines 956-962:
  ```js
  function resolveConfig(runtime, config) {
    if (!runtime.Config) return config;
    const result = runtime.Config["~standard"].validate(config);
    if ("then" in result) throw new TypeError("Async config validation is not supported");
    if (result.issues) throw new ValidationError(result.issues);
    else return result.value;
  }
  ```
  So `Config` must be a **Standard-Schema** object. DSH's schema library is
  `@deepseek-ai/schemastery` (`import z from "@deepseek-ai/schemastery"`, dependency
  `"@deepseek-ai/schemastery": "~3.18.4"` in dsh-tool-present's package.json).
  `.default(...)` fills an omitted value (`maxFiles` defaults to 8; `policy` to `"ask"`), and a
  Schemastery `Config` of an activated row also drives `Config.listConfigs` JSON-Schema introspection.
  `null`/omission takes the fallback "unless required rejects it first" (app-boot schema `$comment`, line 2923).

### 1f. `inject`

`Inject.resolve` (`cordis\lib\index.js` lines 1491-1499) turns `["tools","fs"]` or
`{ tools: interceptConfig }` into a service map; the plugin's `apply` only runs once those services exist
(and it re-runs if they come back). The row can also carry `inject:` in YAML — real example,
`/dsh/node_modules/@deepseek-ai/dsh-acp-app/cordis.patch.yml`:

```yaml
- insert:
    - id: acp
      name: '@deepseek-ai/dsh-acp'
      inject: [acpAppStartup]
      config: { provider: deepseek-official, model: deepseek-v4-flash }
```

### 1g. UI plugins add a Client half (optional)

`host-plugin.md`/`ui-plugin.md` + `templates/decoration/`:

```json
{
  "name": "@local/my-decoration", "version": "1.0.0", "private": true, "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

- `index.js`: `export function apply() {}` (host half may be a no-op).
- `client.js` is a browser artifact that registers a lazy factory whose **id equals the package name**:
  ```js
  window.__ModuleLoader__.load({
    id: '@local/my-decoration',
    factory(require) { const React = require('react'); /* ... */
      return { inject: ['slots'], apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'my-decoration', order: 5 }, Decoration));
      } };
    },
  });
  ```
- `dsh.client` is validated in `...\@deepseek-ai\dsh-client-modules\lib\index.js` lines 61-75:
  `platform` (required string), `inject` (string[]), `external` (string[]), `immediately` (boolean).
  A package that declares `dsh.client` but has no `exports["./client"]` throws
  `client-modules: <pkg> declares dsh.client but exports no "./client" bundle` (line 719).
- Optional display metadata (read without activating): top-level `"icon": "./icon.svg"` (SVG/PNG/JPEG/WebP,
  ≤256 KiB, must stay inside the package dir), `locale/en.json` `meta.title`/`meta.description`, and
  `exports["./package.json"]` + `exports["./locale/*.json"]` (host-plugin.md lines 29-45).

---

## 2. How an entry is declared in the Cordis loader tree, and how a user adds one

### 2a. The profile root is empty; everything is a patch layer

`C:\Users\Administrator\.dsh\profiles\desktop\cordis.yml` (whole file, 4 lines):

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

Composition order (`...\@deepseek-ai\dsh-app-boot\lib\index.js` lines 466-475, 920-956, 1023-1034):

1. each package in the profile manifest's `dsh.profile.bundles`, in order — its `dsh.bundle.patch`
   file(s) parsed and flattened (a string, or an ordered list `bundlePatchFiles()` lines 495-499);
2. the profile's own `cordis.patch.yml` (`PROFILE_PATCH_FILENAME`, line 487);
3. `$DSH_HOME/cordis.patch.yml` (i.e. `C:\Users\Administrator\.dsh\cordis.patch.yml` — absent here);
4. launcher `--patch` overlays and flag-derived patches (telemetry opt-out).

### 2b. Exact row shape (real rows from the shipped bundles)

`/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` lines 15-32:

```yaml
- insert:
    - id: tool-plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager/tools'
      disabled: true

    - id: plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager'
      disabled: !!js "!ctx.get('profileContext')"

    - id: hmr
      name: '@deepseek-ai/dsh-hmr'
      disabled: !!js "!ctx.get('profileContext')"
      config:
        root: []
```

`/dsh/node_modules/@deepseek-ai/dsh-acp-app/cordis.patch.yml` (whole file) shows id-targeted overrides,
a row-level `inject`, and `config`-only overrides (no `name`, no `insert`):

```yaml
- id: system-prompt
  config:
    personaSuffix: Your working directory is {{cwd}}.
- id: session-title-llm
  disabled: true
- insert:
    - id: acp
      name: '@deepseek-ai/dsh-acp'
      inject: [acpAppStartup]
- id: hmr
  disabled: true
```

Row fields, from the generated schema (`app-boot\lib\index.js` `metadata()` lines 2721-2753):
`id`, `name` ("Plugin module specifier. Inserted relative plugin paths are anchored beside their patch
file."), `config`, `group`, `disabled` (boolean or `!!js`), `inject`, `intercept`, `isolate`.
`group: true` + `name: cordis:group` turns `config` into a nested entry list that patches can insert into
by id; `cordis:include` loads a literal YAML/JSON entry list from `config.path`. Real group example:
`/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml` lines 42-48:

```yaml
          - id: planning
            name: cordis:group
            group: true
            isolate:
              planMode: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
```

### 2c. Accepted patch vocabulary — exactly two operations, no `insertBefore`/`insertAfter`

The one implementation is `applyEntryPatches` in `app-boot\lib\index.js` lines 61-110
(doc comment lines 47-59 calls it "THE patch semantics"), mirrored in
`...\@deepseek-ai\cordis-plugin-include\lib\index.js` lines 68-90:

```js
for (const patch of patches) {
  const { id, insert, name, ...overrides } = patch;
  if (insert) {
    if (id) {                              // insert INTO a group row named by id
      const target = entryMap.get(id);
      if (!target) { warn("patch insert: entry %C not found", id); continue; }
      if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
      if (!Array.isArray(target.config)) target.config = [];
      target.config.push(...insert);
    } else data.push(...insert);           // append at top level
    buildMap(insert); continue;
  }
  if (!id) { warn("patch: id is required for non-insert patches"); continue; }
  const target = entryMap.get(id);
  if (!target) { warn("patch: entry %C not found", id); continue; }
  if (name && name !== target.name) { warn("patch: name mismatch for %C ..."); continue; }
  for (const [key, value] of Object.entries(overrides)) { if (key === "id") continue; target[key] = value; }
}
```

Consequences an author must know:

- `insert: [...]` appends (top level, or inside the `config` list of the `group: true` row named by `id`).
- An id-targeted patch **replaces the whole `config`** (never a deep merge) — restate every field.
- A truthy `name` in a non-insert patch is an **assertion**, not a rename; mismatch warns and skips.
- Fields other than `id` are silently ignored on an `insert` patch.
- Unknown target row / non-insert patch without id → warning + skip (never fatal).
- **`insertBefore` and `insertAfter` do not exist** — grep over `dsh-app-boot\lib\index.js` and
  `cordis-plugin-include\lib\index.js` finds no such key anywhere; order is append-only.
- Inserted `name`s that are absolute or start with `./`/`../` are rewritten to `file://` URLs anchored
  beside the patch file (`anchorInsertedPluginNames`, lines 3537-3545), applied to bundle overlays,
  the profile patch, the home patch and `--patch` files alike (`parsePatchList` line 3570).
- `!!js` scalars are Loader expressions (`userPatchesSchema = entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`,
  lines 28-34, 3460); in `config` and `disabled` they are evaluated against the plugin's own context.
- Non-mapping patch entries, a non-array file, or a YAML parse error in a patch file **throw at boot**
  (lines 3559-3571) — only per-patch target misses are soft.

### 2d. How a user adds their own plugin

Two routes, one sanctioned:

1. **Sanctioned (managed):** author the bundle directory anywhere in the workspace, then
   `plugin_manager` `action: install_bundle`, `target:` the **absolute package directory**
   (skill `SKILL.md` line 8; `editing-cordis-compositions` SKILL.md line 52). The manager runs
   `pnpm add <spec>` in the profile and appends the bundle name to `dsh.profile.bundles`.
   `SKILL.md` lines 8-10 explicitly says: *"Do not write the profile's `package.json` or
   `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory:
   `install_bundle` performs those steps."*
2. **Manual (works, hot-reloaded):** add an `insert` row to
   `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`, e.g.

   ```yaml
   - insert:
       - id: my-plugin
         name: '@local/my-plugin'      # or './my-plugin/index.js' (anchored beside this file)
         config: {}
   ```

   That file is a top-level YAML array of patch entries (its own header says so, lines 1-3) and is
   watched for HMR by dsh-hmr (see §5), so the row mounts on save without restarting DSH.
   Existing content of that file is id-targeted overrides only — e.g. the live file:

   ```yaml
   - id: agent-default-model
     name: "@deepseek-ai/dsh-agent-default-model"
     config: { provider: deepseek-account, model: deepseek-flash, reasoningEffort: max }
   ```

Note the naming split that trips people up: a *bundle* is a package with `dsh.bundle.patch`; the plugins
it mounts are rows whose `name` is a module specifier. `plugin_manager` install/remove works at bundle
granularity, `set_plugin` toggles individual rows by id (and writes/updates the last matching override in
the user patch — plugin-manager README line 40).

---

## 3. How a plugin gets installed as a package

### 3a. Where — the profile directory

`...\@deepseek-ai\dsh-plugin-manager\lib\index.js`:

- `installBundle(spec, options)` (line 1691) → `this.runPnpm(["add", spec, ...registryArguments(registry)], ...)`
  (lines 1749-1753). `runPnpm` spawns pnpm with `cwd: this.profile.dir` (lines 335/518/651/700/745/989,
  and `const cwd = this.profile.dir;` at line 1906).
- Profile dir = `C:\Users\Administrator\.dsh\profiles\<profile>` (`resolveProfileDir`, app-boot lines 524-527).
- Packages therefore land in `<profile>\node_modules`; proof from the second profile:
  `C:\Users\Administrator\.dsh\profiles\market\node_modules\dshmarket\` (+ `.pnpm`, `js-yaml`, `undici`,
  `argparse`), with `pnpm-lock.yaml` beside `package.json`.
- CLI equivalent: `dsh plugin --profile <name> add|remove|install ...` (pnpm arguments, run in the profile
  dir; relative path specs are anchored at the shell cwd, `anchorPathSpec` lines 215-219 used at 504/517;
  `dsh\lib\plugin-BGnVfe_D.js` lines 63-99).

### 3b. Manifest fields it reads

| Field | Where read | Meaning |
|---|---|---|
| `dsh.profile.bundles` (profile `package.json`) | app-boot line 921; written by `selectBundle` lines 1979-2004 | ordered bundle selection = the patch layers |
| `dependencies` (profile `package.json`) | before/after diff, lines 1778-1783 | identifies which package the run installed |
| `dsh.bundle.patch` (plugin `package.json`) | `bundlePatchFiles` app-boot 495-499; plugin-manager 226-229 | one patch path or an ordered list; **absence ⇒ not a bundle** |
| `peerDependencies` | `evaluatePluginCompatibility` (see §4) | install/activation gate |
| `description`, `icon`, `locale/*.json` `meta` | plugin-manager README lines 31/44 | display only, no activation |
| `dsh.client` | `dsh-client-modules\lib\index.js` 61-75 | browser half of a UI plugin |

Absence of `dsh.bundle` is handled two ways: `installBundle` fails with code `not-bundle` (line 1786, then
restores `package.json`/`pnpm-lock.yaml`), while a plain dependency arriving by other means only produces
`dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`
(line 251). There is no `dsh.bundle` field other than `patch`, and `dsh.profile` only exists in the profile
manifest.

### 3c. Local-directory installs — supported

`...\@deepseek-ai\dsh-plugin-manager\lib\types\install-spec.js` lines 57-86 (`parseInstallSpec`):

```js
const path = spec.replace(/^(?:file|link):/, '');
if (path !== spec || isAbsolute(path)) {
  if (!isAbsolute(path)) throw invalid(spec, 'a local path must be absolute');
  return TARBALL_SPEC.test(path) ? { kind: 'tarball', spec, path } : { kind: 'path', spec, path };
}
if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) throw invalid(spec, 'a local path must be absolute');
```

So `file:C:\...`, `link:C:\...` and a bare absolute path are all valid `install_bundle` targets
(`plugin_manager` requires them absolute because the Host's cwd is meaningless to a browser user);
the CLI additionally anchors `./x` and `../x` against the invoking shell's cwd.
pnpm records a local directory dependency as `link:` (or `file:` for a tarball) — a third-party installer
treats exactly those prefixes as "locally developed install"
(`...\dshmarket\src\routes.ts` line 4085: *"restore 只适用于 link:/file: 的本地开发安装 / Restore only applies
to locally developed link:/file: installs"*; `src\sources.ts` lines 865-874 recognize `link:` specs).
`linkedProfileRoots` (app-boot 625-657) treats every symlink under the profile's `node_modules` that points
outside the profiles tree as a "linked root" with its own module-resolution layer, so a symlinked local
checkout is first-class.

### 3d. What the profile's `pnpm-workspace.yaml` implies

`C:\Users\Administrator\.dsh\profiles\desktop\pnpm-workspace.yaml` (whole file):

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

- `packages: [.]` — the profile root is the **only** workspace member; a plugin directory elsewhere is not
  a workspace member, so `workspace:*` specs and a shared lockfile are not available. Use `file:`/`link:`
  (or a registry/git spec) for local development.
- `nodeLinker: hoisted` — flat, hoisted `node_modules` under the profile (no `.pnpm`-only isolation), which
  is what a host application that resolves plugin dependencies by name needs.
- `autoInstallPeers: false` — an installed plugin's peer dependencies are **not** installed into the profile.
  They do not need to be: app-boot's runtime resolver supplies them from the DSH installation
  (`profile.js` module docstring, lines 477-481: *"Module resolution is two-anchor by construction: a bundle
  name resolves first from the dsh installation … then from the profile directory. Pnpm-managed entries in
  the profile's `node_modules` resolve first. The runtime resolution supplies packages carried by the
  installation and selected bundles to Node's ESM and CommonJS resolvers."*). Proof: `dshmarket` declares a
  required peer `@deepseek-ai/cordis` yet the market profile's `node_modules` contains no `@deepseek-ai/*`.
- The file is also where pnpm 11 records build-script approvals (`allowBuilds`); plugin-manager's
  `approvedBuilds` path writes there on the user's behalf — the market's copy carries an extra
  `minimumReleaseAgeExclude: [dshmarket@1.66.20]`, showing other pnpm settings are legitimate here.

### 3e. Install result semantics

`ChangeResult` (`...\dsh-plugin-manager\lib\typert.host.js` line 837):

```ts
export interface ChangeResult {
  changed: boolean;
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
  stage: 'install' | 'enable' | 'remove';
  target: string; enabled?: boolean; error?: ManagementError; warnings?: string[];
  packageResult?: PackageResult; bundle?: string; pendingBuilds?: string[]; approvedBuilds?: string[];
  registries?: Registry[]; failedAt?: 'registry' | 'spec-host';
}
```

`application: 'applied'` is set only when the `hmr` service exists (line 2042:
`application: this.ownerContext.get("hmr") !== void 0 ? "applied" : "restart-required"`), and
`installBundle` returns `"restart-required"` when the installed name was **already** a dependency
(line 1801: `if (Object.hasOwn(before, name)) return "restart-required";`) — i.e. replacing an installed
package needs a process restart to load a fresh JavaScript module generation.

---

## 4. Does a plugin declare DSH compatibility?

**Yes — and the enforced field is `peerDependencies` on `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`.**

`...\@deepseek-ai\dsh-app-boot\lib\index.js` lines 286-313 (`evaluatePluginCompatibility`):

```js
if (!Object.hasOwn(fields, "peerDependencies")) return void 0;
for (const [name, range] of Object.entries(dependencies)) {
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  const requirement = ["workspace:^","workspace:~","workspace:*"].includes(range) ? runtimeVersion : range;
  if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true }))
    peers[name] = range;
}
```

- Runtime version = the version in `@deepseek-ai/dsh-app-boot/package.json` (lines 271-274) — **0.2.0-rc.2** here.
- Enforcement: profile startup skips the offending bundle into `skippedBundles` with reason
  `pluginCompatibilityWarning(issue)` (lines 929-931); `plugin_manager` refuses the install/selection with
  code `incompatible-version` before pnpm runs for named specs (lines 1787-1788, 1986-1987).
- Bypass: the profile's own `compatibility.json`, an exact `package@version` → list of exact DSH versions map
  (lines 326-410 `readProfileCompatibility`, 421+ `setProfileVersionExemption`); `dsh plugin --profile <p>
  allow-version <pkg@ver> --dsh-version <ver> --accept-risk`, or `plugin_manager`
  `set_version_exemption` with `acceptRisk: true`.
- **Nuance:** only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are checked. `@deepseek-ai/cordis`
  and `@deepseek-ai/schemastery` peers match neither branch and are skipped by this gate.

Real field excerpts:

`...\@deepseek-ai\dsh-tool-present\package.json` lines 37-45:

```json
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "0.2.0-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/dsh-fs": "0.2.0-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
    "@deepseek-ai/dsh-session-projection": "0.2.0-rc.2",
    "@deepseek-ai/dsh-session": "0.2.0-rc.2",
    "@deepseek-ai/cordis": "~4.0.4"
  }
```

`...\@deepseek-ai\dsh-base\package.json` lines 31-35 + 131-133:

```json
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  ...
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.4" }
```

Third-party: `C:\Users\Administrator\.dsh\profiles\market\node_modules\dshmarket\package.json` lines 42-59:

```json
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-settings": "^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-theme"], "platform": "web" }
  }
```

Two **optional, author-declared** manifest fields also exist per
`...\@deepseek-ai\dsh-package-manifest\README.md` lines 20-38: `dsh.manifestVersion` (format id, `1`) and
`engines.dsh` (SemVer range beside `engines.node`), documented as *"Omitting them leaves the format version
or compatible host versions undeclared; readers do not infer defaults."*
**Flag:** no shipped runtime reads either in this build — grep for `manifestVersion` and `.engines` across
all extracted `lib/*.js` and package.json files finds zero readers, and `dsh-package-manifest/lib/index.js`
is an 11-byte types-only stub. Treat them as declarations for tooling, not gates.

---

## 5. Hot module replacement for a locally developed plugin

HMR is provided by `@deepseek-ai/dsh-hmr`, mounted by dsh-base (`- id: hmr`, `name: '@deepseek-ai/dsh-hmr'`,
`disabled: !!js "!ctx.get('profileContext')"`, **`config: {root: []}`**) — i.e. in a profile-launched
Desktop session HMR is ON, but **module watching is off by default**; only configuration watching runs.

### 5a. Always active (no configuration needed)

`...\@deepseek-ai\dsh-hmr\lib\index.js` lines 339-377: when `profileContext` exists, HMR registers exact
watches on

- `<profile>\cordis.patch.yml` (`profile.patchPath`),
- `C:\Users\Administrator\.dsh\cordis.patch.yml` (home patch),
- `<profile>\package.json` — reloads only when the ordered `dsh.profile.bundles` list actually changes,

and on a change re-reads `readProfilePatches` → `reconcileProfilePatches` → Loader entry update.
So **editing the profile patch (rows, config, `disabled`) takes effect immediately, no restart** —
including an `insert` row for your plugin. That is also why `plugin_manager` can report
`application: 'applied'`.

### 5b. For edits to plugin *code* to take effect without restarting DSH

Set the hmr row's module roots in the profile patch (dsh-hmr README lines 27-34) — `config` is replaced
wholesale, so restate `root`:

```yaml
- id: hmr
  config:
    root: ["."]                    # or an absolute path, e.g. "D:/work/my-plugin"
```

Mechanics (`dsh-hmr\lib\index.js`):

- Config schema lines 237-247: `base` (defaults to the entry tree base URL = profile dir),
  `root` default `["."]`, `ignored` default `["**/node_modules", "**/.*", "cache", "data"]`,
  `debounce` default 100 ms.
- Watch setup lines 379-392: `watch(root, { ...config, cwd: realpathSync(baseDir), ignored: p => match(relative(watchBaseDir, p)), ignoreInitial: true })`
  — chokidar, with `awaitWriteFinish` defaulting to true (2 s write-stability window, README line 47).
- Change handling lines 393-437 + `partialReload()` lines 516-624: files known to Node's module load cache
  are stashed; the ESM `loadCache` entries and CJS `require.cache` entries for accepted files are cleared,
  the modules are re-imported, and the plugin is re-applied with the **same config**, transferring the
  existing entry/fiber; changes to the CLI entry's dependency tree are "externals" → `loader.exit()` full
  reload; unrelated changes emit `hmr/change`.
- Because watched paths use `realpathSync` spelling, a `link:`ed package is watched at its **real** source
  directory. Practically: point `root` at the real plugin directory (an absolute path is simplest) — a
  plugin sitting under `<profile>\node_modules` is excluded by the default `**/node_modules` ignore.

### 5c. Client (browser) half — separate mechanism, also live

`...\@deepseek-ai\dsh-client-hmr\lib\index.js` lines 45-115: the Host stat-polls **every client-graph row's
declared bundle** (`ctx.clientModules.artifactBaseline(row.id)`, `pollIntervalMs` default 500) and on
mtime/ctime/size change calls `clientModules.rebuilt(id)`, which it also broadcasts as a `rebuilt` frame
over the `/plugins/events` SSE channel (lines 140-161). The page's `__ModuleLoader__` then re-executes the
factory: *"Each successful reload re-executes the plugin bundle and remounts the plugin with fresh state …
React state inside the reloaded plugin is lost, while session, workspace, and connection state survives"*
(README). So editing the file named by your manifest's `exports["./client"]` is picked up in the open page
without a refresh. The documented repo-side chain (`pnpm run dev:web` + the shared Client tsdown preset) is
for working inside the DSH checkout; the stat poll itself is path-based.

### 5d. What still needs a restart

- Replacing an already-installed package version: plugin-manager returns `application: 'restart-required'`
  (line 1801) and the README's limitation *"Package replacements require restarting the process to load a
  fresh JavaScript module generation."*
- Framework/dependency changes: dsh-hmr calls the host's `loader.exit()` ("HMR itself does not restart the
  process"; README limitations).
- Profile resolution pinning (app-boot lines 1367-1369): *"profile resolution: removing local package X
  requires a process restart"* and *"overriding X locally requires a process restart"* (the latter when the
  name already exists among installation-carried entries — e.g. forking a shipped `@deepseek-ai/dsh-*`
  package locally). Adding a new, uniquely named local plugin does not hit this.
- The Client module graph has its own loading mechanism; a Host-side module reload does not imply the
  browser artifact changed.

---

## Flagged / not determined

1. Bundle `cordis.patch.yml` files and the in-repo authoring skills are **absent** from the temp extraction
   (`...\dsh-asar-x\ex\dsh\...` has only `lib/`, `dist/`, `package.json`, `README.md`). I read them from
   `D:\dsh\AppData\DeepSeek Harness\resources\app.asar` with a purpose-written ASAR reader; inner paths are
   `/dsh/node_modules/@deepseek-ai/<pkg>/...`. Reproduce with
   `node C:\Users\Administrator\AppData\Local\Temp\dsh-asar-x\asar-dump.mjs "<asar>" cat <inner-path> <out>`.
2. The authoritative authoring docs are the shipped agent skills
   `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` (SKILL.md + 6 references + 2 templates)
   and `.../cordis-composition-reference/` — inside `app.asar`, unreadable by shell/glob/rg from inside
   Desktop (the skill itself notes this).
3. I could not *execute* anything (no pnpm run against a profile, no DSH restart), so: the exact spec text
   pnpm writes for a local directory (`link:` vs `file:`) is inferred from the third-party market code and
   `install-spec.js`, not observed; `dsh plugin`'s help text was not run.
4. `dsh.manifestVersion` / `engines.dsh` are documented but have no runtime reader in this build (§4).
5. Plugin-manager README line 135: *"Desktop package operations remain owned by the Desktop shell"* — for the
   `desktop` profile the install itself may be performed by the Desktop shell rather than the plugin-manager
   service; the profile has no `node_modules` yet.
6. `dsh.client.external` semantics (non-baseline runtime imports) were only read at the validator level, not
   exercised.
