# Host API Reference

The main process exposes a fixed RPC surface. Workers call it with `rpc.{module}.{method}(...args)`. Every call passes two checks before execution:

1. **method permission** — the plugin must declare the capability in `manifest.permissions`; otherwise the host throws `PERMISSION_DENIED` (`-2107`);
2. **resource whitelist** — for `fs.*`, `net.*`, `child.*` and `dialog.*`, the requested path / URL / command is checked against the resource grant store (DATA, fsDirs, grants, confirm dialogs).

All methods are async and return plain serializable values. Errors carry a `DlientErrorCode` (`-2107` denied, `-1005` invalid, `-1003` user denied, `-1006` dialog canceled, …).

## 0. Calling convention

```ts
import { createWorkerRpc } from '@dlient-open/plugin-sdk'
const rpc = createWorkerRpc('my-plugin')

const content = await rpc.fs.read('C:/tmp/a.txt')          // string
await rpc.fs.write('C:/tmp/out.bin', { base64: 'aGVsbG8=' }) // binary
const userData = await rpc.app.getPath('userData')          // no permission needed
```

- `fs.read`/`fs.write`/`app.data.*` return/accept JSON-safe values; binary goes as `{ base64: string }`.
- Internal host helpers (`child.register`/`unregister`/`killTree`, `plugins.registry.*`, dev plumbing) are not documented here — use the SDK wrappers instead.

> **Typed single source**: all host-api signatures / options / returns / English docs are kept in `@dlient-open/api-types` (source of truth: main-process `app/src/main/api/*`). Worker surfaces them via `@dlient-open/plugin-sdk`, UI via `@dlient-open/api-bridge`. When you change a host-api, first sync `api-types/src/modules/*` — both sides then follow automatically.
>
> **Only plugin-callable APIs are listed**: this reference covers host-apis callable by ordinary plugins (local / dev). Each api-table entry carries a **scope** (call-channel gate: `all` / `worker` / `ui` / `system`) and a **level** (install-risk label shown in the import confirm dialog: `default` grey / `warn` orange / `dangerous` red). **System-scope APIs** (`os.openExternal`, `os.showItemInFolder`, `permission.revoke`, `plugin.capabilities`, `plugin.start/stop`, …) are **not listed** — the open-source host has **no system plugins**, so ordinary plugins calling them get `PERMISSION_DENIED` (`-2107`, system-only).

## 1. File system — `fs.*`

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `fs.read` | `(path: string)` | `fs.read` | Read a UTF-8 text file → `string` |
| `fs.write` | `(path: string, data: string \| { base64: string })` | `fs.write` | Write atomically (tmp + rename) |
| `fs.append` | `(path: string, data: string \| Buffer)` | `fs.write` | Append text/buffer |
| `fs.delete` | `(path: string)` | `fs.delete` | Recursively delete file/dir |
| `fs.stat` | `(path: string)` | `fs.read` | Stats; throws if missing |
| `fs.listDir` | `(path: string)` | `fs.read` | → `[{ name, isDirectory, isFile, size, mtimeMs }]` |
| `fs.watch` | `(path: string)` | `fs.watch` | Watch a dir → `watchId`; events are pushed to your own `registerHandler('<pluginId>.fs-watch-event')` as `[watchId, filename]` |
| `fs.unwatch` | `(watchId: string)` | `fs.watch` | Stop watching |
| `fs.copyDir` | `(src: string, dest: string, exclude?: string[])` | `fs.write` | Copy a tree; `dest` must be inside `userData` |
| `fs.lock` | `(path: string, opts?)` | `fs.write` | Cross-process lock → `{ lockId }` |
| `fs.unlock` | `(path: string, lockId: string)` | `fs.write` | Release a lock |
| `fs.withLock` | `(path: string, op: { method: 'read'\|'write'\|'append', … }, opts?)` | `fs.write` | Run one op while holding the lock |

Examples:

```ts
const text = await rpc.fs.read('C:/tmp/a.txt')
await rpc.fs.write('C:/tmp/out.txt', 'hello')
await rpc.fs.write('C:/tmp/img.png', { base64: b64 })
await rpc.fs.copyDir('C:/src', 'C:/dest', ['node_modules', '.git'])
const watchId = await rpc.fs.watch('C:/src')   // events → registerHandler('<id>.fs-watch-event')
```

Paths are realpath-resolved before authorization (symlink escapes rejected). `DATA` is granted by default; everything else needs `fsDirs` or a grant.

## 2. Network — `net.*`

Workers currently run with `--allow-net` (temporary: direct `node:net`/`fetch` allowed). The host `net.*` stays available for gated access.

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `net.fetch` | `(url: string, init?: { method?, headers?, body? }, description?: string)` | `net.request` | Fetch and return the full response |
| `net.request` | `(urlOrOptions, description?: string)` | `net.request` | Lower-level request |
| `net.getFreePort` | `()` | — | Allocate a free port → `number` |
| `net.probePort` | `(port: number)` | — | Probe local TCP readiness → `boolean` |

Example:

```ts
const res = await rpc.net.fetch('https://api.example.com/data', { method: 'GET' }, 'fetch remote data')
const port = await rpc.net.getFreePort()
```

Unauthorized URLs raise a `net-access` confirm dialog; grants are stored per domain / URL prefix.

## 3. Dialogs — `dialog.*`

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `dialog.showOpenDialog` | `(permissions: ('fs.read'\|'fs.write'\|'fs.delete')[], options: Electron.OpenDialogOptions, description?: string)` | the requested `fs.*` | Native picker + grant the chosen paths → `{ filePaths, granted }` |
| `dialog.showSaveDialog` | `(options: Electron.SaveDialogOptions)` | — | Save picker → `{ filePath }` + save-session write grant |
| `dialog.showMessageBox` | `(options: Electron.MessageBoxOptions)` | — | Native message box |

Example:

```ts
const { filePaths, granted } = await rpc.dialog.showOpenDialog(['fs.read'], { properties: ['openFile'] }, 'Pick a config to import')
const { filePath } = await rpc.dialog.showSaveDialog()
await rpc.fs.write(filePath, data)
```

> The dialog grants the selected scope on accept; later `fs.*` calls on the picked paths pass without an extra confirm.

## 4. Subprocesses — `child.*`

The host spawns and tracks processes. Prefer the SDK wrappers `rpc.child.spawn` / `rpc.child.execFile` (they return a `ChildHandle`).

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `child.spawn` | `({ cmd: string, args?: string[], cwd?, env?, detached?, description? })` | `child.spawn` | SDK `rpc.child.spawn` → `ChildHandle`（自动 child-subscribe 回放 + child-event 流式推送） |
| `child.execFile` | `({ cmd: string, args?: string[], cwd?, env?, timeout?, description? })` | `child.execFile` | One-shot capture → `{ stdout, stderr, code }` |
| Handle (non host-api) | — | — | `ChildHandle` from `rpc.child.spawn`; kill / stdin / events go through `child-control` / `child-subscribe`. Legacy `child.kill` / `readOutput` / `writeStdin` / `stdinEnd` removed |

Example:

```ts


const handle = await rpc.child.spawn({ cmd: 'git', args: ['log', '-1'], description: 'read last commit' })
handle.onStdout((chunk) => log.info('git', chunk))
handle.onExit(({ code, reason }) => log.info('exit', { code, reason }))
await handle.kill()

const { stdout } = await rpc.child.execFile({ cmd: 'node', args: ['--version'] })
```

Command authorization: plugin dir / `DATA` / `node_modules/.bin` are allowed; other commands need `spawnCmds` or `spawn-confirm`. `argsPattern` violations are hard-rejected.

## 5. App & window — `app.*`

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `app.getVersion` | `()` | — | Host version → `string` |
| `app.getName` | `()` | — | App name |
| `app.getLocale` / `app.getSystemLocale` | `()` | — | Current / OS locale |
| `app.isActive` / `app.isHidden` | `()` | — | Window focus / visibility state |
| `app.getPath` | `(key: string)` | — | Paths: `userData` (isolated), `home`, `documents`, `downloads`, `temp`, … |
| `app.data.read` | `(file: string)` | `app.data` | Read `<userData>/plugin-data/<pluginId>/<file>.json` → parsed JSON |
| `app.data.write` | `(file: string, data: unknown)` | `app.data` | Write isolated JSON (atomic) |
| `app.crypt.encrypt` / `app.crypt.decrypt` | `(payload)` | `app.crypt` | Per-plugin key encryption |
| `app.shortcut.register` | `(accelerator: string, cb: () => void)` | `app.shortcut.register` | Register a global shortcut |
| `app.shortcut.unregister` | `(accelerator: string)` | `app.shortcut.register` | Unregister |
| `app.menu.popup` | `(items: MenuItemTemplate[])` | `app.menu` | Native context menu → clicked item id |
| `app.window.close/focus/blur/show/hide/maximize/unmaximize/minimize/restore` | `()` | `app.window` | Main-window control |
| `app.window.setFullScreen` | `(flag: boolean)` | `app.window` | Full screen on/off |
| `app.notify` | `({ event: string, receiver?: string[], data?: unknown, event_id?: string })` | — | Emit a NOTIFY bus event (renderer receivers only) |
| `app.event` | (subscribe) | `app.event` | Forward host events (theme / language) |
| `system.listenNativeTheme` | (subscribe) | `system.listenNativeTheme` | Follow OS theme changes |

Example:

```ts
const settings = (await rpc.app.data.read('settings.json')) as Record<string, unknown>
await rpc.app.data.write('settings.json', { theme: 'dark' })
await rpc.app.notify({ event: 'my-plugin.data-changed', data: { file: 'settings.json' } })
```

### 5.1 Credentials & hosted subprocesses (`app.crypt`)

`app.crypt.encrypt/decrypt` is **per-plugin** AES-256-GCM: a plugin key is derived via HKDF from the host master key (`info = pluginId`), the master key never leaves the main process, and ciphertext is `base64(version ‖ iv ‖ tag ‖ ct)`. The same plugin can decrypt its own ciphertext across sessions/restarts; other plugins cannot (isolation).

Typical flow — keep a secret off the disk in plaintext, then hand it to a hosted subprocess:

```ts
// 1) persist encrypted, never plaintext
const enc = await rpc.app.crypt.encrypt(token)
await rpc.app.data.write('secrets.json', { gh: enc })

// 2) later (even after worker restart): read → decrypt in memory only
const stored = (await rpc.app.data.read('secrets.json')) as { gh?: string }
const token = await rpc.app.crypt.decrypt(String(stored.gh))

// 3) pass it to a hosted child WITHOUT putting it on the command line:
const handle = await rpc.child.spawn({
  cmd: 'git', args: ['push', 'origin', 'HEAD'],   // no token in argv
  cwd,
  env: { GH_TOKEN: token },                        // kept explicitly; host env is stripped otherwise
  description: 'git push',
})
handle.onStderr((c) => log.warn('git', c))
await handle.kill()
```

Rules:

- **Never place credentials in `argv`** — they surface in the process list, in the `spawn-confirm` full-command dialog and in host audit logs.
- Hand secrets over `env` (only the entries you pass are kept; the host strips the rest) or `stdin` (`handle.write`). Never write them to logs or `console`.
- A native-host child is a hosted spawn too: decrypt in the worker, inject via `rpc.child.spawn` env. The child itself cannot call `app.crypt` (the key lives in the main process) — it only receives the decrypted value for the process lifetime.
- Plugin isolation: ciphertext produced by plugin A cannot be decrypted by plugin B (HKDF info differs). Do not hand ciphertext to another plugin expecting it to decrypt.

### 5.2 Built-in Node.js runtime — `nodejs.*`

`nodejs` is **not a plugin** in the open-source host: the runtime lives in the host main process and is exposed as a normal host-api module (declare the matching `nodejs.*` keys in `manifest.permissions`). There is no `plugin.invoke('nodejs', …)` any more — migrate to `rpc.nodejs.*`.

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `nodejs.checkLocal` | `({ version? })` | `nodejs.checkLocal` | Probe a local (PATH / well-known paths) Node.js runtime |
| `nodejs.checkBundled` | `({ version? })` | `nodejs.checkBundled` | Probe the host-bundled runtime (`~/.dlient-open/plugin-data/nodejs`) |
| `nodejs.resolveRuntime` | `({ version? })` | `nodejs.resolveRuntime` | Resolve a usable runtime (bundled preferred, then PATH) → `{ node?, source, … }` |
| `nodejs.install` | `(version?)` | `nodejs.install` | Install the bundled LTS runtime (single-flight; downloads under `userData`) |

`dlient.nodeVersion` (or a `nodejs` dependency entry) triggers host readiness gating: the layout/launcher shows "not ready" until a matching runtime exists, treating `nodejs` as a runtime placeholder (installed automatically when missing) rather than a missing plugin.

## 6. Clipboard

> `os.openExternal` / `os.showItemInFolder` are **system-scope** APIs (unreachable for ordinary plugins — the open-source build has no system plugins) and are not listed here.

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `clipboard.readText` | `()` / `(type?)` | `clipboard.read` | Read clipboard text |
| `clipboard.writeText` | `(text: string, type?)` | `clipboard.write` | Write clipboard text |
| `clipboard.readHTML` / `writeHTML` | `(type?)` / `(html, type?)` | read / write | HTML payloads |
| `clipboard.readRTF` / `writeRTF` | `(type?)` / `(rtf, type?)` | read / write | RTF payloads |
| `clipboard.readBookmark` / `writeBookmark` | `()` / `(title, url)` | read / write | Bookmarks |
| `clipboard.readImage` / `writeImage` | `(type?)` / `(image)` | read / write | Images |
| `clipboard.readFindText` / `writeFindText` | `()` / `(text)` | read / write | Find text |
| `clipboard.clear` | `(type?)` | `clipboard.write` | Clear clipboard |
| `clipboard.availableFormats` | `(type?)` | `clipboard.read` | → `string[]` |
| `clipboard.has` | `(format, type?)` | `clipboard.read` | Has format? |
| `clipboard.read` / `write` | (format based) | read / write | Generic format read/write |
| `system.getIdleState` | `(thresholdSec)` | `system.getIdleState` | OS idle state |

`type` values follow Electron: `'selection'` / `'clipboard'` (optional).

## 7. Notifications

> v2 (docs/specs/notification-v2.md): `send` returns a **handle**; events (click/close/reply/action/failed/show) are pushed back by the host;
> macOS foreground uses the built-in notification strip (top-right, non-fullscreen); `remove/removeGroup` are owner-checked and work on both system & in-app engines.
> HTML5 `new Notification()` is disabled in the renderer — always use this module.

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `notification.isSupported` | `()` | — | Whether system notifications are supported |
| `notification.send` | `({ title, body?, silent?, hasReply?, replyPlaceholder?, actions?, closeButtonText?, timeoutType? })` | `notification.send` (or prefix group) | Send a notification → handle `{ id }`; `n.on("click"/"close"/"reply"/"action"/"failed"/"show", cb)`; `n.close()` |
| `notification.remove` | `(id)` | `notification.remove` | Close own notification (owner-checked; other's id → `PERMISSION_DENIED`; system & in-app) |
| `notification.removeGroup` | `()` (no group id) | `notification.removeGroup` | Close all notifications of this plugin (incl. custom group_id) |
| `notification.subscribe` / `notification.unsubscribe` | `({ id })` | exempt (owner-checked) | Subscribe/unsubscribe notification events (used by SDK handle automatically) |

> Identity fields (`group_id` = plugin instanceKey, `group_title`/`subtitle` = plugin name (i18n), `icon` = plugin icon) are force-injected by the host from the sending plugin — passing them is ignored; `hasReply` defaults false, `actions` defaults [], `timeoutType` defaults `'default'` (`'never'` keeps system engine on Windows; in-app `'never'` = no auto-dismiss).
> Platform notes: `actions`/`hasReply` only supported on macOS system notifications; Windows/Linux system notifications are click-only — action/reply capability is carried by the built-in notification (auto-routed on macOS foreground).

## 8. Cross-plugin calls & plugin install

> `plugin.start/stop`, `plugin.capabilities`, `permission.revoke` and other host-management APIs are **system-scope** — the open-source host has no system plugins, so plugins cannot call them. Ordinary plugins call other plugins' exposed methods via `plugin.invoke` (authorization: `dependencies` declaration + the target's `access`/`grant` / user three-way confirmation). The `plugin.dev.*` / `plugin.logs.*` primitives are **worker-scope** host APIs used by the host's repo/dev flow — plugins rarely need them directly.

| Method | Args (types) | Permission | Purpose |
| --- | --- | --- | --- |
| `plugin.invoke` | `(targetPluginId: string, method: string, args: unknown[])` | — | Call another plugin's exposed method (also available as `rpc.plugin.invoke`); validated against `dependencies` + target `expose` |
| `plugin.requestGrant` | `(targetPluginId, method, data?)` | — | Ask the target plugin for authorization proactively → `{ allowed, scope?, reason? }` |
| `plugin.install` | `({ id, kind: 'file'\|'npm'\|'github'\|'url', source, description })` | `plugin.install` | Install a plugin (`.dlient` path / npm / GitHub release / URL). All fields required; the host shows a **user confirm dialog** first, then installs — deep-installing `preInstall` dependencies. Worker scope, `dangerous`. |
| `plugin.setActive` | `(pluginId \| null)` | `plugin.setActive` | Set the active content-area plugin (null clears it) |
| `plugin.dev.selectDirectory` | `()` | `plugin.dev`-family | Directory picker (repo/dev flow) |
| `plugin.dev.getDirInfo` | `(pluginId)` | `plugin.dev`-family | Resolve a dev plugin dir |
| `plugin.dev.sync` | `(entries)` | `plugin.dev`-family | Report the dev plugin list |
| `plugin.dev.readLogs` | `(pluginId, { offset?, maxBytes? })` | `plugin.dev`-family | Read another plugin's log tail |
| `plugin.dev.clearLogs` | `(pluginId)` | `plugin.dev`-family | Clear the target log file |
| `plugin.dev.startDevWorker` / `stopDevWorker` | `(pluginId)` | `plugin.dev`-family | Manually start / stop a dev-instance worker |
| `plugin.dev.startWatcher` / `stopWatcher` | `(pluginId)` | `plugin.dev`-family | Start / stop the hot-reload watcher |
| `plugin.dev.isPortReady` | `(pluginId)` | `plugin.dev`-family | Dev-instance worker port ready? |
| `plugin.logs.subscribe` | `(pluginId)` | `plugin.logs`-family | Subscribe to live plugin logs → `{ subId }` |
| `plugin.logs.unsubscribe` | `(pluginId, subId)` | `plugin.logs`-family | Unsubscribe |

Example:

```ts
const cfg = await rpc.plugin.invoke('plugin-auth', 'plugin-auth.getConfig')   // == plugin.invoke
```

## 9. Webview

Embed web content by rendering the **`Webview` component from `@dlient-open/ui`** in your UI (never create views manually — see `references/ui.md` §2.1). **No `manifest.permissions` entry is needed**: the component calls the host through the view-bound client injected by `PluginView` (view identity + HMAC signature), and the host only lets a view operate the views *it* created.

Once a view is inserted, control its visibility in two ways:

- **Component-level (most common)** — pass the `visible` prop to the `Webview` component (`<Webview src={url} visible={activeTab === id} />`); the component syncs visibility to the host for you.
- **Host-level show/hide (multi-view / tab orchestration)** — use the injected client (`useWebviewClient()`):

| Client method | Args (types) | Purpose |
| --- | --- | --- |
| `showMine(views?: string[])` | `(views?: string[])` | Show this plugin's views (restore exactly the listed cached `viewId`s when provided) |
| `hideMine()` | `()` | Hide this plugin's views → returns the hidden `viewId` list for later exact restore |

```tsx
import { useWebviewClient } from '@dlient-open/ui'

const wv = useWebviewClient()   // bound to the current view; null outside a PluginView
const res = await wv?.hideMine() // → { code, data: string[] } (cached ids)
await wv?.showMine(cachedIds)    // exact restore
```

Keep a view mounted and toggle `visible` to preserve its page state; unmount only to destroy it (the host reclaims the views created by that view automatically, even if the unmount-time request cannot be delivered). Remember the `viewId` from `Webview`'s `onViewReady` when you need host-level exact restoration.

## 10. Worker-side convenience (WorkerRpc)

| API | Notes |
| --- | --- |
| `rpc.registerHandler(method, handler)` | Expose a callable method (pair with `manifest.expose`) |
| `rpc.registerStreamHandler(method, handler)` | Streaming handler (`ctx.emit` ×N, auto `stream-done`) |
| `rpc.{module}.{method}(...args)` | The one way to call host capabilities — method name = host-api key, matching `manifest.permissions`; `rpc.child.spawn/execFile` are SDK wrappers (see §4) |
| `rpc.plugin.invoke(pluginId, method, args)` | Cross-plugin (same as `plugin.invoke`) |
| `rpc.push(event, data?)` | Push an event to the plugin's renderer view (UI subscribes via `api.onEvent`) |
| `rpc.registerSnapshotHandler / registerRestoreHandler` | Business-state snapshot / restore across hot reload |
| `rpc.effect(install)` / `rpc.onReady(cb)` / `rpc.onDispose(cb)` | Lifecycle: reversible side effects, ready, host-stop cleanup |
| `rpc.success(data?)` / `rpc.error(code, msg?)` | Build response envelopes (bare returns auto-wrap) |
| `rpc.registerChildEvent / unregisterChildEvent` | Hosted-subprocess event dispatch |
| `rpc.getPluginId()` | Running identity (`<id>` or `<id>@dev`) |
| `rpc.log(level, message, data?)` | Report a log line |

## 11. UI-side direct host-api (renderer)

Plugin **UI** can call a low-risk subset of host APIs directly via `api.{module}.{method}(...args)`
(from `useDlientApi()`), so a pure-UI plugin may skip the worker for simple cases. The UI-callable whitelist (source of truth:
`UI_OPEN_METHODS` in `app/src/main/export.ts`, surfaced via `@dlient-open/api-bridge`) is in `references/ui-api.md`.
Everything outside the open list must go through your worker with `rpc.{module}.{method}`.

The full member list with types is in `worker.md` §3. There is no `useEffect` in a worker — it is plain Node; subscription cleanup happens in the UI (`useEffect` + `api.onEvent`).
