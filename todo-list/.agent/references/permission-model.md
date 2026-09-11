# Permission Model (sandbox + resource grants)

Authoritative spec: `docs/specs/plugin-permission.md`. This file is the condensed developer guide.

## 1. Process-level sandbox

Workers are started through `utilityProcess.fork` with the **Node Permission Model** injected:

```
--permission
--allow-fs-read=<plugin dir>,<shared runtime dirs>   # minimal read set only
--allow-net                                           # TEMPORARY policy (2026-09-02)
```

- **Banned at the process level**: spawning child processes, loading `.node` addons, file writes, `worker_threads`.
- `--allow-net` is a **temporary** full allowance for `node:net`/`fetch` (many npm packages connect directly). Strict mode will remove it; host `net.*` grants are the primary path afterwards.
- fs writes, subprocesses and native modules must go through the host (`fs.*`, `child.*`) or the **native-host** child (full-permission official Node process for `.node`).
- Dev-only escape hatches: `DLIENT_DISABLE_PERMISSION=1` (skip `--permission`), `DLIENT_DISABLE_FS_ENFORCE=1` (skip fs path checks).

### Process pools

- `workerMode: 'solo'` or `source: 'dev'` (without a `#plugin` / `@org` pool group) → exclusive pool (one plugin per process).
- Otherwise a shared pool groups plugins. **Shared pool = mutually trusting plugins** (same process, shared JS heap); plugins holding sensitive data should use `solo`.

### Native-host

Native modules never run inside the worker. They run in a host-managed full-permission Node child:
- `native` → `.node` vendored in dist, rebuilt for Electron ABI, per platform;
- `nativeModules` → installed user-side via npm (`dependencies`) and resolved by the native-host.

The host spawns it (`child_process.spawn`), tracks it by owner, and **auto-restarts on crash**; in-flight RPC requests are rejected on restart.

## 2. Two-layer authorization

1. **Method permissions** — `manifest.permissions` entries checked by `HostCapabilities.canAccess` for every host-api call.
2. **Resource whitelist** — for files, URLs and commands:

| Grant kind | Meaning | Lifetime |
| --- | --- | --- |
| `DATA` | `USER_DATA/plugin-data/<pluginId>` | always granted |
| `fsDirs` / `spawnCmds` | declared in manifest | confirmed at install |
| `fs-grants` / `net-grants` / `spawn-grants` | user picked "always allow" | persistent, revocable, persisted encrypted |
| `session-grants` | user picked "this time only" | in-memory, lost on host restart |
| `temp-grants` | save flow | 30s TTL backstop; a hit promotes to a session grant (save-as session) |

## 3. Runtime confirmation (unified dialog)

When a plugin first touches something outside its whitelist, the host opens one unified confirm dialog (renderer). Types:

| Dialog | Trigger | Grants |
| --- | --- | --- |
| `fs-access` | `dialog.showOpenDialog(permissions, options, description?)` | read/write grants for chosen paths |
| `net-access` | `net.fetch` / `net.request` on an unauthorized URL | URL/domain grant |
| `spawn-confirm` | `child.spawn` / `child.execFile` of an undeclared command | command grant |
| `runtime-confirm` | cross-plugin method with `access: 'runtime-confirm'` | permanent / session grant (user three-way choice) |

Every dialog offers **scope**: **always** (persistent) / **only this time** (session) / **deny**. The plugin never chooses the scope itself.

- `description` argument customizes the dialog text.
- **Batch**: `permission.request([{ type, resource, mode?, description? }, …])` shows one dialog listing several grants (all / per-item / deny + scope).

### Cross-plugin call authorization (dependencies prerequisite + target `grant`)

Cross-plugin calls (`plugin.invoke` / `rpc.plugin.invoke`) go through this chain:

1. **`dependencies` prerequisite** — the caller must declare the target method (or plugin id) in `manifest.dependencies`; declared + target `access` allows → direct call; undeclared and no existing grant → next step;
2. **target `grant`** — the main process calls the target's `grant({ method, plugin_id, version, data? })`, which returns one of three states:
   - `allow` → writes a **permanent** grant (expiresAt=null) and proceeds;
   - `deny` → rejected (denial error code, shown in the UI);
   - `ask` → user three-way confirm dialog (deny / allow once / always allow).
3. Target **without `grant`** (not exposed / declared but not implemented) → **call rejected**.
- The caller may also ask proactively: `rpc.plugin.requestGrant(pluginId, method, data?)`.

## 4. File access flow (example)

```ts
// 1. user picks files AND consents to grants in one flow
const { filePaths, granted } = await rpc.dialog.showOpenDialog(['fs.read'], { properties: ['openFile'] }, 'Load the config you want to import')

// 2. read through the host (realpath-checked + whitelisted)
const content = await rpc.fs.read(filePaths[0])

// save: no confirm dialog (explicit intent), save-scope grant:
const { filePath } = await rpc.dialog.showSaveDialog()
await rpc.fs.write(filePath, data)   // re-saving later still works (session)
```

## 5. Path rules & hardening (summary)

- Path checks resolve the deepest existing ancestor with `realpath`; symlink escapes are rejected. Authorization and the actual I/O use the **same resolved path**.
- `fsDirs` aliases resolve at plugin start; aliases unavailable on the current OS (e.g. `RECENT` on Linux) log a warning instead of silently degrading.
- Corrupt grant files are renamed `<file>.corrupt-<ts>` and logged (no silent reset).
- Denials and revocations are written as structured `security` log lines (audit).

## 6. Spawn command rules

Manifest `spawnCmds` accepts:

```jsonc
"spawnCmds": [
  "git",                                            // command only, args unconstrained (legacy)
  { "cmd": "python3", "argsPattern": "[-]c .*" }    // per-argument anchored regex
]
```

Verdicts at runtime: `allow` / `nomatch` (goes to `spawn-confirm`) / `args-denied` (hard reject + audit log). Granting a command at runtime authorizes the command itself (args unconstrained — a user-visible trade-off); the confirm dialog always shows the **full command line**.

## 7. Receiving events from the host

Subprocess streams and lifecycle are pushed to the worker over the control channel (`child-event` messages), delivered by the SDK to `ChildHandle` callbacks (`onStdout/onStderr/onExit/onError`). Host → renderer events use the NOTIFY bus (`app.notify`, receiver-addressed).
