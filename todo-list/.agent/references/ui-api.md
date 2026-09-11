# UI Direct-connect API Reference (ui-api)

> The plugin **UI** (renderer) can call a **low-risk subset** of host-apis **directly** via `useDlientApi()`'s `api.{module}.{method}(...args)` — pure-UI plugins (`type:'app'`, no worker.js) can skip a worker for simple cases.
>
> - Source of truth for the open list = `UI_OPEN_METHODS` in main-process `app/src/main/export.ts` (renderer types are surfaced via `@dlient-open/api-bridge`'s `UI_HOST_API_PATHS`, same source);
> - The UI channel shares the same `executeHostApi` as the worker channel (scope checks + declaration + fs whitelist); methods outside `UI_OPEN_METHODS` are rejected even when their scope is `all`;
> - host-apis **outside** this whitelist must be called through the plugin worker via `rpc.{module}.{method}` (UI direct calls are rejected);
> - **System-scope APIs are not open** (the open-source host has no system plugins; calling them gets `PERMISSION_DENIED`).

## 1. Calling convention

```ts
import { useDlientApi } from '@dlient-open/api-bridge'
const api = useDlientApi()

const text = await api.fs.read('C:/tmp/a.txt')          // string
await api.app.data.write('settings.json', { theme: 'dark' })
const port = await api.net.fetch('https://api.example.com/data', { method: 'GET' }, 'fetch remote data')
```

Signatures / args / returns match the worker-side host-api (see host-api-reference.md); the UI exposes the same-named methods through `@dlient-open/api-bridge`.

## 2. Open list (directly callable from the UI)

### 2.1 Host info / window state (`app.*`)

| Method | Purpose |
| --- | --- |
| `app.getVersion()` / `app.getName()` | Host version / app name |
| `app.getLocale()` / `app.getLocaleCountryCode()` / `app.getSystemLocale()` / `app.getPreferredSystemLanguages()` | Read-only locale info |
| `app.getPath(key)` | Whitelisted paths (`userData` → plugin-isolated `plugin-data/<id>`; `plugins` → install root) |
| `app.isActive()` / `app.isHidden()` | Read-only active / visible state |
| `app.notify({ event, receiver?, data? })` | Emit NOTIFY bus event (renderer receivers) |

### 2.2 Plugin data / crypto (`app.data.*` / `app.crypt.*`)

| Method | Permission | Purpose |
| --- | --- | --- |
| `app.data.read(file)` | `app.data` | Read `<userData>/plugin-data/<id>/<file>.json` (per-plugin isolation) |
| `app.data.write(file, json)` | `app.data` | Atomic isolated JSON write |
| `app.crypt.encrypt(plain)` / `app.crypt.decrypt(b64)` | `app.crypt` | Plugin-level AES-256-GCM (master key stays in main process; isolated between plugins) |

### 2.3 Locale / system / network (`i18n.*` / `system.*` / `net.*`)

| Method | Authorization | Purpose |
| --- | --- | --- |
| `i18n.getLocale()` | — | Read-only current host locale |
| `system.getIdleState(threshold?)` | `system.getIdleState` | Read-only system idle state |
| `net.isOnline()` | — | Read-only network connectivity |
| `net.fetch(url, init?, description?)` | `net.request` (net-grants domain whitelist + first-time confirm) | Fetch full response; SSRF-protected (no internal/loopback) |
| `net.request(options, description?)` | `net.request` | Low-level request |

### 2.4 Dialogs (`dialog.*`)

| Method | Authorization | Purpose |
| --- | --- | --- |
| `dialog.showOpenDialog(permissions, options, description?)` | declared `fs.*` | System picker + grant selected paths → `{ filePaths, granted }` |
| `dialog.showSaveDialog(options)` | — | Save picker → `{ filePath }` + session write grant |
| `dialog.showMessageBox(options)` | — | Native message box |

### 2.5 Notifications (`notification.*`)

| Method | Authorization | Purpose |
| --- | --- | --- |
| `notification.isSupported()` | — | System notification support |
| `notification.send(options)` | `notification.send` (or prefix group) | Send → handle `{ id }`; `on("click"/"close"/"reply"/"action"/"failed"/"show", cb)`; `close()` |
| `notification.remove(id)` | `notification.remove` | Close own notification (owner-checked) |
| `notification.removeGroup()` | `notification.removeGroup` | Close all notifications of this plugin |
| `notification.subscribe/unsubscribe({ id })` | exempt (owner-checked) | Handle event subscribe / unsubscribe |

### 2.6 File system (`fs.*`)

| Method | Authorization | Purpose |
| --- | --- | --- |
| `fs.read(path)` / `fs.stat(path)` / `fs.listDir(path)` / `fs.watch(path)` / `fs.unwatch(id)` | **fs-grants read whitelist** | Read file / stat / list / watch / unwatch |
| `fs.mkdir(path)` / `fs.write(path, data)` / `fs.append(path, data)` / `fs.delete(path)` / `fs.copyDir(src, dest, exclude?)` / `fs.lock/unlock` / `fs.withLock` | **fs-grants write whitelist** | Write / directory operations (grants from manifest.fsDirs / `dialog.showOpenDialog` / `permission.request`) |

### 2.7 Clipboard (`clipboard.*`)

| Method | Authorization | Purpose |
| --- | --- | --- |
| `clipboard.read*` (readText / readHTML / readRTF / readBookmark / readFindText / readImage / readBuffer / read / has / availableFormats) | `clipboard.read` | Read clipboard |
| `clipboard.write*` (writeText / writeHTML / writeRTF / writeBookmark / writeFindText / writeBuffer / write / clear) | `clipboard.write` | Write / clear clipboard |

### 2.8 Others (`permission.*` / `log.*`)

| Method | Authorization | Purpose |
| --- | --- | --- |
| `permission.request(resources, description?)` | — | **Resource-grant entry** (batch fs/net/spawn); handler shows a confirm dialog then writes grants |
| `log.write(level?, message?, data?)` | `log` | Write this plugin's log (undeclared → `-2107` denied, recorded to plugin log) |

## 3. Not open (UI direct calls rejected)

- **System-scope APIs**: `plugin.capabilities`, `permission.revoke`, `os.openExternal` and other system-scoped methods are not open to the UI (no system plugins in the open-source host; calls are rejected);
- All other whitelist-excluded host-apis (`child.*`, `app.createNative*`, `app.window.*`, `screen.*`, `plugin.invoke`, …): call through the worker via `rpc.{module}.{method}` (the `UI_OPEN_METHODS` list in `app/src/main/export.ts` is the single source of truth). Note: webview is **no longer a host-api** — `window.dlient.webview.*` is a first-party preload channel used internally by the `<Webview>` component.
