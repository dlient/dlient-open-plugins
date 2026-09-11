***

name: dlient-plugin-dev
description: Develop plugins for the dlient desktop host. Covers scaffolding with @dlient-open/create-plugin, the plugin manifest schema, worker (utilityProcess) and UI (SystemJS remoteEntry) development, host-api calls, and the sandbox + permission model. Use when creating, building, debugging, or distributing a dlient plugin.
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# dlient Plugin Development

## 1. Overview

dlient is an Electron-based desktop host that loads third-party plugins. A plugin has two optional halves:

- a **worker**: runs inside an Electron `utilityProcess` (Node runtime, no DOM, no renderer) — owned by the host's **worker pool**;

- a **UI**: a React bundle compiled as `System.register` (`remoteEntry.js`) loaded by the host renderer through SystemJS.

Three design principles shape every plugin:

1. **Sandbox first**: every worker is started with the Node Permission Model (`--permission` + minimal `--allow-fs-read`). It cannot fork children, load `.node` addons, or touch the file system directly.
2. **Host mediation**: everything a worker needs (files, network, dialogs, subprocesses, system APIs) goes through **host-api** calls. The main process validates every call.
3. **Permission model**: method-level permissions (declared in `manifest.permissions`) plus resource-level grants (paths, URLs, commands) that users approve at runtime.

## 2. When to use this skill

- **Distributing a plugin locally**: build it as a `.dlient` package and share or import it. The open-source host has **no plugin market, no server and no online publishing** — distribution and installation are local only.

- Creating and iterating on a **plugin in the repo dev source dir** (`dlient-open/plugins/<id>`, `source: 'dev'`) or a **local import** (`source: 'local'`, installed into the host `plugins/` dir).

- **Importing an existing plugin** for self-use (host console → "Import plugin" → pick the `.dlient`).

- **Debugging and troubleshooting**: worker logs, permission denials, host-api errors, hot reload (output-level watch).

## 3. Core concepts

| Concept          | Meaning                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest         | `dlient` sub-object of `package.json`; declares identity, type, UI/worker shape, permissions, fs dirs, spawn commands, exposed methods.                                                            |
| Worker pool      | Host spawns workers in pools. `workerMode: 'solo'` (or `source: 'dev'`) gives a plugin an exclusive pool (one plugin, one process). Default `shared` groups low-sensitivity plugins.               |
| Host-api         | RPC surface exposed by the main process: `rpc.fs.read(path)`. Every call passes method permission + resource whitelist checks.                                                    |
| Permission model | Process-level bans (`--permission`, no child-process/addon/fs-write) + resource-level grants (`fs-grants` / `net-grants` / `spawn-grants` / session / temp). See `references/permission-model.md`. |
| Native modules | `.node` binaries cannot load in a worker. Use `native` (vendored, per-platform) or `nativeModules` (installed user-side) — both run in a dedicated full-permission Node child (native-host). See `references/native-host.md`. |

## 4. Plugin development workflow

1. **Scaffold** — `npx @dlient-open/create-plugin my-plugin`. Creates the template in `my-plugin/`.
2. **Install & build** — `cd my-plugin && npm install && npm run build` (UI → `dist/remoteEntry.js` + assets; worker → `dist/worker.js`).
3. **Develop the worker** — edit `src/main/index.ts` (optional).
4. **Develop the UI** — edit `src/renderer/App.tsx` + `i18n.ts` + `styles.css` (optional).
5. **Run & debug** — iterate against the open-source host:

   - dev workflow: place the plugin in the repo dev source dir (`dlient-open/plugins/<pluginId>`) and run `npm run dev` — it watches the output (`vite build --watch` + worker esbuild `--watch`); output changes take effect after you reopen / reload the host (no dev-server port).

   - release-like flow: run `npm run pack` and import the generated `.dlient` from the host console ("Import plugin" → confirm dialog → deep install).

   - logs live at `USER_DATA/plugin-data/<pluginId>/logs/main.log` (`USER_DATA` = `~/.dlient-open`).

Detailed steps, CLI flags and the template tree: `references/create-plugin.md`.

## 5. Manifest authoring guide

The manifest is the `dlient` object in `package.json`. Required fields:

- `name` and `description` — string or multi-locale mapping `{ default, "zh-CN", "en-US" }`; **both required**.

- `icon` — **required** string path (e.g. `assets/icon.svg`).

Common fields:

| Field            | Purpose                                                                   | Default                                                                   |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `type`           | `app` / `full` / `worker` / `ui`                                          | `app`                                                                     |
| `version` / `id` | identity                                                                  | falls back to top-level `package.json`                                    |
| `dist`           | output dir relative to plugin root                                        | `dist`                                                                    |
| `permissions`    | host capabilities requested (e.g. `fs.read`, `child.spawn`)               | —                                                                         |
| `platforms`      | simple array of the six OS.arch combos (`win32.x64`, …, `linux.arm64`)   | all platforms                                                             |
| `workerMode`     | `shared` / `solo`                                                         | `shared`                                                                  |
| `source`         | `local` / `dev` (open source: no `market`; imports are forced to `local`, `system=false`) | `local`                                                      |
| `nodeVersion`    | minimum Node.js requirement (e.g. `"22"`); triggers host readiness gating and the bundled-runtime install | —                                              |
| `preInstall`     | install-time dependency map `{ pluginId: "0.5.1" \| github repo URL \| .dlient URL }` — deep-installed when importing/installing | —                       |
| `expose`         | methods other plugins may call (each may carry `access` + `paramsSchema`) | —                                                                         |

A concise **full-field quick table and a complete commented example** live in `references/manifest-schema.md`.

## 6. Calling the host (host-api)

From the worker:

```ts
import { createWorkerRpc } from '@dlient-open/plugin-sdk'

const rpc = createWorkerRpc('my-plugin')

const text = await rpc.fs.read('C:/tmp/a.txt')        // needs fs.read
await rpc.fs.write('C:/tmp/out.bin', { base64: '…' }) // needs fs.write
const p = await rpc.app.getPath('userData')           // no permission
```

Group overview:

- **fs.\*** — read / write / delete / stat / listDir / watch (per-path whitelist enforced by the host);

- **net.\*** — fetch / request (URL grants), `net.isOnline`, `net.getFreePort`, `net.probePort`;

- **dialog.\*** — `showOpenDialog(permissions, options, description?)`, `showSaveDialog(options)`, `showMessageBox(options)`;

- **child.\*** — `spawn` / `execFile` (SDK wrappers returning a `ChildHandle`; handle kill / stdin / events), host-spawned, command whitelist + args rules;

- **nodejs.\*** — built-in Node.js runtime (checkLocal / checkBundled / resolveRuntime / install). `nodejs` is **not a plugin**: the runtime is built into the host main process; declare `nodejs.*` in `manifest.permissions` (there is no `plugin.invoke('nodejs', …)` any more);

- **app.\*** — data (isolated storage), window, menu, shortcut, crypt, notify, getPath, etc.;

- **webview** — not a host-api any more: render the **`Webview` component from `@dlient-open/ui`** (view-bound client injected by `PluginView`, **no permission needed**); `useWebviewClient()` exposes `hideMine()` / `showMine(ids)` for tab orchestration;

- **clipboard / os / notification / log / permission** — thin wrappers;

- **plugin.install** — install a plugin from a `.dlient` path / npm / GitHub release / URL; the host shows a user confirm dialog first and deep-installs `preInstall` deps (worker scope, dangerous);

- **plugin.invoke** and **rpc.plugin.invoke** — call another plugin's exposed methods.

Full per-method docs with params, types and examples: `references/host-api-reference.md`.

## 7. Permissions

- **Static (declarative)**: list capabilities in `manifest.permissions` (e.g. `fs.read`, `child.spawn`) and resources in `fsDirs` / `spawnCmds`. The user confirms these at install time.

- **Runtime (interactive)**: when a plugin first touches something outside its whitelist, the host opens a unified confirmation dialog:

  - `fs-access` — grant a file/directory (from `dialog.showOpenDialog`);

  - `net-access` — grant a URL/domain;

  - `spawn-confirm` — grant a command;

  - `runtime-confirm` — grant cross-plugin method access.

- Each dialog offers a **scope**: `always` (persistent grant) / `this time only` (session grant) / `deny`.

- **Batch**: `permission.request(resources[])` lets a plugin ask for several grants in one dialog.

- Sandbox escape hatches for development only: `DLIENT_DISABLE_PERMISSION=1`, `DLIENT_DISABLE_FS_ENFORCE=1`.

Full model (process bans, grant store, dialog flows, spawn args rules, audit logs): `references/permission-model.md`.

## 8. Coding standards

- Worker rules (sync blocking ban, logging, structured errors, subprocess handles) and UI rules (use `@dlient-open/ui` (shadcn-style) components, icons, i18n, theming): `references/dev-standards.md`.

## 9. Reference files

| File                               | Purpose                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `references/create-plugin.md`      | Scaffolding, template directory tree, dev workflow, build & output watch, debugging, local `.dlient` packaging & import |
| `references/manifest-schema.md`    | Complete manifest field reference with a commented example                                    |
| `references/host-api-reference.md` | Full host-api docs per method: params, types, examples                                        |
| `references/permission-model.md`   | Process sandbox + resource grants + unified confirm dialogs                                   |
| `references/native-host.md`        | Running native modules: native-host architecture, server & client, restartable host, security |
| `references/worker.md`             | Writing the worker: SDK API, RPC, logging, subprocess handles, cross-plugin calls             |
| `references/ui.md`                 | Writing the UI: shared components from `@dlient-open/ui`, hooks, i18n, theming              |
| `references/dev-standards.md`      | Worker + UI development standards                                                             |

