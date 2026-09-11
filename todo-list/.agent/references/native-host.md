# Native Modules & the native-host Mode

Native (`.node`) binaries can never load inside a plugin worker — the process sandbox bans addons. dlient offers two strategies to run native modules:

| | `dlient.native` | `dlient.nativeModules` (native-host, recommended) |
| --- | --- | --- |
| `.node` ships in | `dist`, vendored | plugin `node_modules`, installed user-side via npm |
| ABI | Electron ABI (`@electron/rebuild`, per platform) | **official Node ABI** (no rebuild) |
| Distribution | inside the `.dlient` (must declare `platforms`) | not packaged — the host runs `npm install` per `dlient.nativeModules.dependencies` on import/install |
| Runtime | loaded by a dedicated **official Node child** (native-host) | same |

Both run in a **native-host**: a full-permission official Node child process spawned and owned by the host, running your `dist/native-host.js`. This guide focuses on the native-host mode.

## 1. Why native-host

- Native modules match the **official Node ABI** (not Electron's), so no `@electron/rebuild`.
- The native-host child runs outside the sandbox with full Node — your native module just works.
- The host **spawns it, tracks it by owner, reclaims it when the worker exits, and auto-restarts it on crash** (in-flight RPC requests are rejected on restart).
- One native-host per plugin — never shared across plugins.

## 2. Architecture & data flow

```
plugin worker (utilityProcess, sandboxed, pure JS)
   │  expose handler, e.g. my-plugin.query
   ▼
worker-side client: createNativeHostClient({ transport: createHostedTransport(handle) })
   │  spawn (host child.spawn): cmd = official node, args = [dist/native-host.js], cwd = distDir
   ▼
host main process: child.spawn (command whitelist) + stdio pipe (duplex)
   │  length-prefixed JSON-RPC over stdin/stdout (handle.write / handle.end (child-control), child-event)
   ▼
native-host.js (official Node, full permission): createNativeHostServer()
   │  registerService('sqlite', { init/query/get/run/exec }, onClose?)
   ▼
native module loaded via createRequire → better-sqlite3 / ssh2 / …
```

Only JSON-serializable values cross the pipe. Worker-side data (paths, ids) is passed as parameters; the native-host never touches the DOM or Electron.

## 3. Scaffolding

```bash
npx @dlient-open/create-plugin my-native-plugin --native-host
```

The template adds:

- `src/native-host/index.ts` — the native-host entry;
- `@dlient-open/native-host-sdk` dependency;
- `dlient.nativeModules` in the manifest (fill in `dependencies`).

`script/build-worker.mjs` detects `src/native-host/` and produces **`dist/native-host.js`** (esbuild, `platform: node`).

## 4. Manifest

```jsonc
"dlient": {
  "nativeModules": {
    "dependencies": { "better-sqlite3": "^11.0.0" },   // exact install target(s)
    "useBundledNode": true                               // default true
  }
}
```

Rules:

- `dependencies`: npm package → version/semver; installed user-side into the plugin's `node_modules` by the host on import/install (open source has no market; the `.dlient`/dist carries **no** `.node`, no `node_modules`).
- Also add the module to `devDependencies` for local typings/development.
- `useBundledNode` (default `true`): the native-host must run on the official Node provided by the host's built-in `nodejs` runtime (installed automatically when missing). `false` = any Node on PATH.
- Mutually exclusive with `native`; never declare both. `native` forces `platforms`; `nativeModules` does not.

## 5. Writing the native-host (`src/native-host/index.ts`)

Constraints: **pure Node** — only `node:*` + your native module. No `electron`, no worker SDK.

```ts
// src/native-host/index.ts
import { createRequire } from 'node:module'
import { createNativeHostServer } from '@dlient-open/native-host-sdk'

const require = createRequire(import.meta.url)           // resolve .node from plugin node_modules
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

const host = createNativeHostServer()

host.registerService(
  'notes',
  {
    // params: unknown[] → serializable value (or throw)
    query: (params) => db.prepare(String(params[0])).all((params[1] ?? []) as never[]),
    run: (params) => db.prepare(String(params[0])).run((params[1] ?? []) as never[]),
  },
  () => {
    db.close()           // graceful close when the host shuts down
  },
)
```

- Methods are plain `(params: unknown[]) => value`; errors thrown inside become RPC error envelopes on the client.
- Service state is per-process: initialize lazily (e.g. a `init` service call that receives the data dir from the worker).
- The native-host runs single-threaded and serial — safe for synchronous native APIs (better-sqlite3 style).

## 6. Worker side (client)

Wire the native-host over the hosted child handle:

```ts
// src/main/index.ts
import { createWorkerRpc } from '@dlient-open/plugin-sdk'
import { createHostedTransport, createNativeHostClient, createRestartableNativeHost } from '@dlient-open/native-host-sdk'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const rpc = createWorkerRpc('my-native-plugin')

const buildHost = () =>
  createRestartableNativeHost({
    maxRestarts: 3,                                // quick fail after repeated crash/no-node
    // spawn runs on first call and again after every crash:
    spawn: async () => {
      // resolve the official node (built-in host runtime; declare nodejs.resolveRuntime — installs it when missing)
      const rt = (await rpc.nodejs.resolveRuntime({ version: '22' })) as { node?: string }
      if (!rt.node) throw new Error('node runtime not available')
      const distDir = fileURLToPath(new URL('.', import.meta.url))   // worker.js & native-host.js share dist/
      const entry = join(distDir, 'native-host.js')
      const handle = await rpc.child.spawn({
        cmd: rt.node, args: [entry], cwd: distDir,
        description: 'native-host (native modules)',
      })
      // stdio duplex transport over the ChildHandle
      const client = createNativeHostClient({ transport: createHostedTransport(handle) })
      return { client }
    },
    // new host ready → (re-)initialize state
    onRestarted: async (client) => {
      const userData = (await rpc.app.getPath('userData')) as string
      await client.call('notes', 'init', [join(userData, 'db')])
    },
    onExit: ({ code, reason }) => rpc.log('warn', 'native-host exited', { code, reason }),
  })

let host: ReturnType<typeof buildHost> | undefined
const ensureHost = () => (host ??= buildHost())       // lazy start; crash → auto-restart on next call

// expose to callers, forwarding caller identity into the native-host params (defense in depth)
rpc.registerHandler('my-native-plugin.queryNotes', async (args, ctx) => {
  const h = await ensureHost()
  return h.call('notes', 'query', [String(args[0]), /* ... */ ctx.from_plugin_id])
})
```

Key points:

- `rpc.nodejs.resolveRuntime` returns the official Node binary path (`useBundledNode`); the host installs its bundled runtime on first use when absent (declare `nodejs.resolveRuntime` in `manifest.permissions`).
- `createRestartableNativeHost` gives: lazy spawn on first call, **auto-restart on crash**, in-flight requests rejected during a restart, and an `onRestarted` hook to re-initialize state.
- Use the plain `createNativeHostClient` when you manage the handle yourself (e.g. one-shot tools): `createNativeHostClient({ transport: createHostedTransport(handle) })`.
- Multi-tenant: the native-host cannot know the caller, so the worker forwards caller identity as a parameter; the native-host validates ids/paths again (defense in depth, e.g. per-caller DB files).

## 7. Lifecycle & the host

- The native-host is just a host-mediated `child.spawn`: command whitelist (`spawnCmds` covers the resolved node path) + runtime confirmation if needed.
- On plugin worker exit the host kills the native-host (owner-based cleanup). One plugin → one native-host process.
- Crash of the native-host process does **not** take down the worker — the SDK restarts it; the worker keeps serving.

## 8. Security notes

- The native-host is **full-permission** Node: treat installing/using one as **install-level trust** (the UI warns at install time).
- Keep it narrow: expose only your service JSON-RPC surface, validate every parameter (plugin id whitelist, path checks), never echo full privileges to callers.
- Put permission logic in the worker (which runs the normal permission model); treat native-host-side checks as defense in depth.

## 9. References & examples

- Template: `src/native-host/index.ts` generated by `npx @dlient-open/create-plugin my-plugin --native-host`.
- SDK: `@dlient-open/native-host-sdk` — `client.ts` / `server.ts` / `protocol.ts` and an `example-host.ts` (transport / client / server API).
