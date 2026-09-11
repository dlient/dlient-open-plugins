# Manifest Schema Reference

The manifest is the **`dlient`** sub-object of the plugin's `package.json`. Type source of truth: `PluginManifest` in `@dlient-open/plugin-sdk` (host-side fields such as `preInstall` are documented below).

## 1. Field table

### Identity & display

| Field                                | Type            | Required | Default             | Description                                                |
| ------------------------------------ | --------------- | -------- | ------------------- | ---------------------------------------------------------- |
| `id`                                 | string          | no\*     | top-level `name`    | Unique plugin id (lowercase letters/digits/hyphens)        |
| `version`                            | string          | no\*     | top-level `version` | Semver                                                     |
| `name`                               | `LocalizedText` | **yes**  | —                   | Display name; string or `{ default, "zh-CN", "en-US" }`    |
| `description`                        | `LocalizedText` | **yes**  | —                   | Description (same multi-locale form). Required.            |
| `author` / `homepage` / `repository` | string          | no       | —                   | Metadata (`author` may fall back to top level)             |

\* Required in practice; the host falls back to the top-level `package.json` fields.

### Shape & output

| Field        | Type                                  | Default              | Description                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`       | `'app' \| 'full' \| 'worker' \| 'ui'` | `app`                | `app` (default): standalone app opened by the host launcher; `full`: UI + worker; `worker`: worker only; `ui`: UI only. The legacy `main` / `ui` fields are **deprecated** — the shape is decided by `type` + the presence of `dist/worker.js` in the build output.                                                                               |
| `dist`       | string                                | `dist`               | Output dir relative to plugin root. Artifacts are always a **plain loose directory** (`remoteEntry.js` / `worker.js` / …) — there is no asar packaging / `plugin.json` form.                                        |
| `workerMode` | `'shared' \| 'solo'`                  | `shared`             | `solo`: exclusive pool (one plugin, one process). Dev plugins (`source: 'dev'`) are forced solo unless they set a pool group.                                                                                                                                                                                                                      |

### Origin

| Field        | Type        | Default | Description                                                                     |
| ------------ | ----------- | ------- | ------------------------------------------------------------------------------- |
| `source`     | `'local' \| 'dev'` | `local` | Open source has **no `market` and no `system=true` plugin**: local import / in-development. Any imported plugin is forced to `source='local'`, `system=false`. |
| `platforms`  | `PluginPlatform[]` | all     | Simple array, subset of the **six OS.arch combos**: `win32.x64` `win32.arm64` `darwin.x64` `darwin.arm64` `linux.x64` `linux.arm64`. Empty / absent = all platforms. |

### Icons

| Field        | Type   | Description                                                                         |
| ------------ | ------ | ----------------------------------------------------------------------------------- |
| `icon`       | string | **Required.** Relative path (e.g. `assets/icon.svg` / `.png`). Rendered as `<img>`. |
| `search_api` | string | Reserved search API identifier                                                      |

### Permissions & resources

| Field         | Type                                                  | Description                                                                                                                                |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `permissions` | `PluginPermission[]`                                  | Host capabilities requested (see table below)                                                                                              |
| `fsDirs`      | `{ read?: string[]; write?: string[] }`               | Directory declarations (aliases or absolute paths), read/write separated; confirmed at install                                             |
| `spawnCmds`   | `(string \| { cmd: string; argsPattern?: string })[]` | Spawn command whitelist. `string` = command only (unconstrained args — warns at registration); object = command + per-arg regex constraint |

**`fsDirs`** **directory aliases**: `DOWNLOAD` `DOCUMENT` `DESKTOP` `PICTURE` `RECENT` (Win/mac) `MUSIC` `VIDEO` `HOME` `TEMP` `DATA` (= `USER_DATA/plugin-data/<id>`, granted by default) `PLUGINS` (= `USER_DATA/plugins`). Host-internal directories are not open to plugins.

### Runtime / native

| Field           | Type                                                                 | Description                                                                                                         |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `preInstall`    | `Record<string, string>`                                             | **Install-time dependencies**: `{ <pluginId>: "0.5.1" \| "https://github.com/owner/repo" \| "https://….dlient" }`. The host deep-installs each entry (npm semver / GitHub latest-Release `*.dlient` / direct `.dlient` URL) when importing/installing; keys join the runtime "ready" dependency closure (missing → not ready), but do **not** implicitly open cross-plugin calls — those still need `dependencies`. |
| `dependencies`  | `Record<string, string[]>` / `string[]`                              | Cross-plugin call declaration: keys are the dependency **plugin ids** (values = the expose methods of the target that this plugin calls; a plain array of ids is accepted too). Required for `plugin.invoke` authorization. |
| `nodeVersion`   | string                                                               | Minimum Node (`"22"`, `">=22"`, `"22.11"`). Triggers host readiness gating; the host installs its bundled managed Node when unmet. `nodejs` is treated as a runtime placeholder, not a missing plugin. |
| `native`        | boolean                                                              | `true`: `.node` vendored in dist (must also declare `platforms`). Mutually exclusive with `nativeModules`.          |
| `nativeModules` | `{ dependencies?: Record<string,string>; useBundledNode?: boolean }` | Native modules installed user-side (npm) and loaded by the native-host Node child. `useBundledNode` default `true`. |
| `engines`       | `{ dlient?: string; electron?: string }`                             | Host / Electron version gates                                                                                       |

### Cross-plugin API

| Field   | Type                                                                                                | Description                                                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expose` | `Record<string, { description?: string; access?: string; paramsSchema?: Record<string, unknown> }>` | Methods other plugins may invoke (full dotted key, e.g. `my-plugin.greet`). `access` is an access expression; `paramsSchema` is an optional JSON-Schema description of the arguments (documentation/form generation only — the host does not validate at runtime). |

**`expose`** **access values** (combine with `|` = or, `&` = and):
`private` (self) · `default` (host + self) · `system` (system plugins — open source ships **no system plugins**, so effectively host-internal only) · `public` (any plugin) · `install-confirm` (user confirmed at install) · `runtime-confirm` (user three-way confirmation at call time: deny / allow once / always allow). Confirm tiers need a valid grant to pass; the target may also expose a `grant` method for programmatic authorization (returns `allow` / `ask` / `deny`).

## 2. `permissions` — how to declare

Declared values are the host-api **keys** you want, or their module-prefix group. Examples from the open-source template: `app.crypt`, `app.data`, `app.event`, `app.getPath`, `app.notify`, `dialog.showOpenDialog`, `dialog.showSaveDialog`, `log`, `permission.request`, `plugin.invoke`, plus e.g. `fs.read`, `child.spawn`, `nodejs.resolveRuntime`. Two checks gate every host-api call:

1. **Scope (call-channel gate)** — `all` (any channel) / `worker` (reachable from the worker; UI needs a whitelist entry too) / `ui` / `system` (host-internal only — **unavailable** to plugins in the open-source build, which has no system plugins).
2. **Level (install-risk label)** — `default` (grey dot) / `warn` (orange) / `dangerous` (red); shown in the import confirm dialog.

Common groups (full per-method list: `references/host-api-reference.md`):

| Area | Declared values (examples) | Notes |
| --- | --- | --- |
| File | `fs.read` `fs.write` `fs.delete` `fs.listDir` `fs.watch` | `fs.stat` → `fs.read`; `fs.append`, `fs.copyDir`, `fs.lock`, `fs.unlock`, `fs.withLock`, `fs.mkdir` → `fs.write`; `fs.unwatch` → `fs.watch` (some host methods reuse `fs.read`/`fs.write` — there is no `fs.stat` permission to declare) |
| App | `app.data` `app.crypt` `app.window` `app.menu` `app.shortcut.register` `app.setAutoLaunch` `app.event` | group perms cover `app.data.*` / `app.crypt.*` / `app.window.*` etc. `app.getPath`, `app.notify` are declared as exact keys and are otherwise permission-free |
| Clipboard | `clipboard.read` `clipboard.write` | all `clipboard.*` |
| Dialog | `dialog.showOpenDialog` `dialog.showSaveDialog` | the requested `fs.*` grant is added to the picked paths |
| Child | `child.spawn` | SDK `child.spawn` / `child.execFile` wrappers |
| Webview | (none) | `<Webview>` from `@dlient-open/ui` needs **no** permission: it uses the view-bound client injected by `PluginView` (the host keeps the sandbox + method/event whitelists) |
| Node.js | `nodejs.checkLocal` `nodejs.checkBundled` `nodejs.resolveRuntime` `nodejs.install` | built-in runtime, not a plugin |
| Plugin | `plugin.install` `plugin.setActive` | `plugin.invoke` / `plugin.requestGrant` are base capabilities (no declaration; validated against `dependencies` + target `expose`) |
| Notification | (none) | `notification.send`/`remove` need no permission |
| Log | `log` | `log.write` group prefix |

## 3. Complete example

```jsonc
// package.json
{
  "name": "my-plugin",
  "version": "1.2.0",
  "type": "module",
  "dlient": {
    "id": "my-plugin",
    "version": "1.2.0",
    "type": "full",                       // UI + worker (app is the default)
    "name": { "default": "My Plugin", "zh-CN": "我的插件", "en-US": "My Plugin" },
    "description": { "default": "…", "zh-CN": "…" },   // required
    "icon": "assets/icon.svg",                        // required
    "source": "local",
    "workerMode": "solo",                 // contains sensitive data → solo
    "platforms": ["win32.x64", "win32.arm64", "darwin.x64", "darwin.arm64", "linux.x64", "linux.arm64"],
    "permissions": ["fs.read", "fs.write", "child.spawn", "app.data", "app.crypt", "log"],
    "fsDirs": { "read": ["DOCUMENT"], "write": ["DATA"] },
    "spawnCmds": [                        // interpreters should use object rules (args constrained)
      "git",
      { "cmd": "python3", "argsPattern": "[-]c .*|\\.py|--version" }
    ],
    "nodeVersion": ">=22",                // readiness gating; host installs the bundled runtime when unmet
    "preInstall": {                       // install-time deps → deep-installed on import (npm / github / URL)
      "plugin-helper": "0.5.1",
      "plugin-tools": "https://github.com/someowner/sometools"
    },
    "expose": {
      "my-plugin.greet": {
        "description": "Say hello",
        "access": "public",
        "paramsSchema": { "type": "object", "properties": { "name": { "type": "string" } } }
      }
    },
    "dependencies": { "plugin-auth": ["plugin-auth.getConfig"] }
  }
}
```
