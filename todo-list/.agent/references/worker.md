# Writing the Worker

The worker runs in the host's `utilityProcess` pool. It is plain Node — no DOM, no renderer. Its only way out is the host-api and cross-plugin RPC.

## 1. Entry & build

- Source: `src/main/index.ts` (template default).

- Build: `node script/build-worker.mjs` → **`dist/worker.js`**.

- The host forks a worker only when `dist/worker.js` exists and the manifest `type` implies a worker (`full`, `worker`, or `app` with a worker file). A `ui`-only plugin never forks.

- `type` decides whether a worker exists; register your handlers idempotently on boot (hot reload re-runs the file).

## 2. Complete example

The following is the full typical worker of a `full`/`worker` plugin (template + common features):

```ts
/**
 * my-plugin worker (src/main/index.ts)
 */
import { createWorkerRpc, PluginError, type WorkerRpc } from '@dlient-open/plugin-sdk'

const rpc: WorkerRpc = createWorkerRpc('my-plugin')
// Logging: rpc.log.write(level, message, data?) — declare manifest.permissions `log` (no fs permission needed)

// ---- 1. Expose methods to other plugins (manifest.dlient.expose must match) ----
rpc.registerHandler('my-plugin.greet', async ([name]: [string?]) => `hello ${name ?? 'world'}`)

rpc.registerHandler('my-plugin.getConfig', async () => {
  // isolated JSON storage (permission: app.data)
  return (await rpc.app.data.read('config.json')) as Record<string, unknown>
})

rpc.registerHandler('my-plugin.saveNote', async ([note]: [string]) => {
  if (!note || typeof note !== 'string') throw new PluginError(-3001, 'note required')
  await rpc.app.data.write('note.txt', { text: note, ts: Date.now() }) // isolated storage (app.data)
  void rpc.log.write('info', 'note saved', { len: note.length })
  return { ok: true }
})

rpc.registerHandler('my-plugin.readPath', async ([path]: [string]) => {
  // arbitrary file read through the host — needs fs.read + fsDirs/grant for the path
  return rpc.fs.read(path)
})

// ---- 2. fs.watch events arrive as a host callback ----
rpc.registerHandler('my-plugin.fs-watch-event', ([watchId, filename]) => {
  void rpc.log.write('info', 'fs watch', { watchId, filename })
})

// ---- 3. Boot: start long-running work, host a subprocess ----
async function boot(): Promise<void> {
  const cfg = (await rpc.app.data.read('config.json').catch(() => ({}))) as Record<string, unknown>

  // host a git subprocess (streamed)
  const git = await rpc.child.spawn({ cmd: 'git', args: ['status', '--short'], description: 'git status' })
  git.onStdout((chunk) => void rpc.log.write('info', 'git out', chunk))
  git.onExit(({ code }) => void rpc.log.write('info', 'git exit', { code }))

  // one-shot capture
  const { stdout } = await rpc.child.execFile({ cmd: 'node', args: ['--version'] })
  void rpc.log.write('info', 'node', stdout.trim())
}

boot().catch((err) => void rpc.log.write('error', 'boot failed', err))
```

Key points from the example:

- **Never** touch `node:fs`/`child_process`/`net` sockets for privileged resources — everything goes through `rpc.{module}.{method}`.

- Register handlers **before/at boot**; keep them idempotent for hot reload.

- Return structured errors via `PluginError`; keep user-facing copy out of the worker.

- `rpc.child.spawn`/`rpc.child.execFile` are SDK wrappers over `child.*` — you get a `ChildHandle`, the host tracks cleanup.

## 3. WorkerRpc API

The interface is defined in `@dlient-open/plugin-sdk` (`WorkerRpc`). Full member list:

| Member                                                                      | Description                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `registerHandler(method, handler)`                                          | Register a callable method (pair with `manifest.expose` for cross-plugin)                               |
| `registerStreamHandler(method, handler)`                                    | Streaming handler: call `ctx.emit(chunk)` repeatedly; `stream-done` is sent automatically on return     |
| `registerSnapshotHandler(fn)` / `registerRestoreHandler(fn)`                | Business-state snapshot / restore across hot reload & restart                                           |
| `rpc.{module}.{method}(...args)` | Call a host capability (see host-api reference); method name = host-api key matching `manifest.permissions`; `rpc.child.spawn` / `rpc.child.execFile` are SDK wrappers returning a `ChildHandle` / `{stdout,stderr,code}` |
| `rpc.plugin.invoke(pluginId, method, args?)` | Cross-plugin call (equivalent to `plugin.invoke`) |
| `rpc.plugin.requestGrant(pluginId, method, data?)` | Ask the target plugin for authorization proactively (allow/ask/deny) → `{ allowed, scope?, reason? }` |
| `push(event, data?)` | Push an event to the renderer view bound to this plugin (subscribed on the UI via `api.onEvent`) |
| `rpc.log.write(level, message, data?)` | Report a log line (`info`/`warn`/`error`/`debug`) |
| `success(data?)` / `error(code, msg?)`                                      | Build `{ code, data/msg, from }` envelopes (bare `return` values are auto-wrapped — usually not needed) |
| `effect(install)`                                                           | Reversible side effect: `install()` returns a disposer, run in reverse before the host stops the worker |
| `onReady(cb)`                                                               | Fired once when the control/direct channel is ready                                                     |
| `onDispose(cb)`                                                             | Host-stop cleanup callback (runs before `effect` disposers; may return a Promise)                       |
| `registerChildEvent(handleId, handlers)` / `unregisterChildEvent(handleId)` | Child-event dispatch for hosted subprocesses                                                            |
| `getPluginId()`                                                             | Running identity (`<id>` or `<id>@dev` for dev instances)                                               |

> No `useEffect`/React here: the worker is plain Node without a DOM. Effect cleanup and event subscription/unsubscription happen in the **UI** via `useEffect` + `api.onEvent` (see `ui.md`).

## 4. Exposing methods to other plugins

```ts
rpc.registerHandler('my-plugin.greet', async ([name]) => `hello ${name}`)
```

Guard the entry in the manifest:

```jsonc
"expose": { "my-plugin.greet": { "description": "…", "access": "public" } }
```

Other plugins declare it in `dependencies` and call `rpc.plugin.invoke('my-plugin', 'my-plugin.greet', ['world'])` (without a `dependencies` declaration they need an existing grant or the target's `grant`). Access levels: `private` (self) / `default` (host + self) / `system` (host-internal — the open-source build ships no system plugins) / `public` (any) / `install-confirm` / `runtime-confirm` (see manifest reference).

## 5. Logging

```ts
void rpc.log.write('info', 'boot ok', { version: '1.0.0' })  // levels debug/info/warn/error
void rpc.log.write('warn', 'slow path')
void rpc.log.write('error', 'boom', new Error('…'))
```

Logs are JSONL in `USER_DATA/plugin-data/<pluginId>/logs/main.log` (source='worker'). Read the file directly or pull lines through the log APIs. **No fs permission needed** — just declare `log` in manifest.permissions; if undeclared, the host rejects (-2107) and writes an error to the plugin log.

## 6. Hosted subprocesses — `rpc.child.spawn` / `ChildHandle`

The worker **cannot** spawn on its own (no `--allow-child-process`). The main process spawns on your behalf through `child.spawn` / `child.execFile`, after checking the command whitelist (`spawnCmds`) or a `spawn-confirm`. The SDK wrappers below are the only spawn entry points a plugin should use.

### 6.1 `rpc.child.spawn` — streamed child

```ts


const handle = await rpc.child.spawn({
  cmd: 'git',
  args: ['status', '--short'],
  cwd: '/work',
  env: { MY_FLAG: '1' },          // merged over the stripped host env (PATH/HOME kept)
  description: 'git status in workspace',   // shown in the spawn-confirm dialog
})

handle.onStdout((chunk) => console.log(chunk))   // child-event streamed
handle.onStderr((chunk) => console.error(chunk))
handle.onExit(({ code, reason }) => console.log('exit', code, reason)) // reason: 'exited' | 'killed'
handle.onError((err) => console.error('spawn failed', err.message))     // e.g. command not found

await handle.kill()               // tree-kill + unregister (idempotent; no-op when already exited)
await handle.write('input line\n') // write stdin (child-control write; duplex for native-host RPC)
await handle.end()                 // close stdin gracefully (child-control end)
```

**`SpawnHostedOptions`**: `cmd: string` (required) · `args?: string[]` · `cwd?: string` · `env?: Record<string, string>` (merged over the stripped env) · `detached?: boolean` · `description?: string` (dialog copy).

**`ChildHandle`** **members**:

| Member                          | Description                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `handleId: string`              | Host-side id (kill/stdin/events go through `child-control` / `child-subscribe`)                       |
| `pid: number`                   | Read-only pid (diagnostics only — never raw-kill)                              |
| `kill(): Promise<void>`         | Idempotent tree-kill + unregister; no-op after exit                            |
| `readOutput()`                  | Poll buffered output / exit state → `{ stdout, stderr, exited, code, signal }` |
| `onStdout(cb)` / `onStderr(cb)` | Streaming output chunks (child-event push; one callback each)                  |
| `onExit(cb)`                    | `{ code, signal?, reason: 'exited' \| 'killed' }`                              |
| `onError(cb)`                   | Spawn failure (e.g. command missing)                                           |
| `write(chunk)` / `end()`        | Write / close stdin (child-control `write` / `end`)               |

- stdout/stderr/exit/error are pushed from the main process over the control channel as **child-event** messages; the SDK dispatches them to your callbacks (single `on*` registration each — re-assign to swap).

- The host tracks the process by owner and reclaims it automatically when your worker exits or restarts — no manual cleanup hooks needed.

### 6.2 `rpc.child.execFile` — one-shot capture

```ts
const { stdout, stderr, code } = await rpc.child.execFile({
  cmd: 'node', args: ['--version'],
  timeout: 10_000,          // optional
  description: 'detect node version',
})
```

Returns `{ stdout, stderr, code }`; use for probes/detection. `timeout` kills after the given ms.

### 6.3 Command authorization & SDK internals

- Allowed without confirmation: executables under the plugin dir / `DATA` / `node_modules/.bin`. Anything else needs `manifest.dlient.spawnCmds` (string = command only; `{ cmd, argsPattern }` constrains arguments) or a `spawn-confirm` at runtime.

- `rpc.child.spawn` internally calls `child.spawn` + `rpc.registerChildEvent(handleId, …)`; `kill()` unregisters the child-event listeners. Prefer these wrappers over touching `child.*` or `registerChildEvent` directly.

- `spawnTracked` / `killTracked` (older API, `child.register`-based) are kept for legacy flows; new code uses the hosted wrappers.

### 6.4 Native tooling & long-running processes

- Native modules or tools that need a full Node environment run in a **native-host** child — see `references/native-host.md`.

- Long-running server-like processes should also be hosted children (host reclaims them on worker exit); do not run them inside the worker event loop.

## 7. Calling another plugin

```ts
const cfg = await rpc.plugin.invoke('plugin-auth', 'plugin-auth.getConfig')
```

The host checks your `manifest.dependencies` declaration and the target's `expose` access before forwarding.

## 8. Structured errors

```ts
import { PluginError } from '@dlient-open/plugin-sdk'
throw new PluginError(-3010, 'config missing')   // code range -3001..
```

Return codes / localized messages; keep user-facing text on the UI side.

## 9. Lifecycle & heartbeats

- Keep the event loop alive. **Never block synchronously** (no `spawnSync`, no sync file I/O): a frozen event loop stops heartbeats and the watchdog restarts/kills the plugin.

- Re-register handlers on boot (hot reload re-runs `dist/worker.js`).

- On worker exit the host reclaims everything owned: child processes, hosted spawn handles, log subscriptions.

