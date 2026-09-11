# dsh (DeepSeek Harness)

Runs the **DeepSeek Harness (dsh)** AI Agent web UI inside dlient, and exposes an embeddable **Chat** component (`dsh --profile dlient-chat`) that any other plugin can drop into its own UI.

> **English** · [简体中文](README.zh-CN.md)

## Overview

```
dsh (app) ─ worker: Node.js → npm i -g @deepseek-ai/dsh → dsh web --no-open
             renderer: <Webview src=http://127.0.0.1:<port>>
Chat (embed) ─ worker: installs the dlient-chat profile → starts the chat service
               renderer: <PluginView pluginId="dsh" entry="Chat">
```

- **Managed runtime** — the worker resolves / installs Node.js through the built-in `nodejs.*` host-api (bundled LTS first, falling back to the system runtime), installs `@deepseek-ai/dsh` on demand, and starts `dsh web --no-open`. npm ships with Node; `pnpm` and DSH are installed into the same npm prefix under the plugin data directory — **the system PATH is never touched**.
- **Two surfaces** — the `dsh` App (full `dsh web` UI) and the embeddable `Chat` (the single-column `dlient-chat` surface). They are independent and can run at the same time.
- **No auto-stop** — the chat service has no idle timer. It stops only when you stop it explicitly, or when the dsh worker / host exits. Collapsing, tab-switching or hiding the Chat view only hides the native WebContentsView (the webContents stays alive), so **nothing reloads**.
- **Language / theme sync** — host language & theme are synced into `~/.dsh/settings.yaml` (backed up as `settings.dlient.yaml`) and restored on stop.

## Features

- Runs dsh inside dlient without pre-installing anything (Node.js resolution happens automatically).
- `Chat` is a named export of the plugin UI module — embed it with `PluginView` from any plugin, pass a `workspace` path, and get a real dsh chat surface wired to that workspace (no process/URL juggling in your plugin).
- Command aliases `CMD_NODE` / `CMD_NPM` / `CMD_PNPM` are host-resolved, so **no command-authorization prompts** appear and grants survive a runtime upgrade.
- `DSH_HOME` defaults to `~/.dsh`, **shared with the command-line dsh** — a plugin added via `dsh plugin --profile web add <pkg>` in a terminal shows up in the app too.

## Usage

1. No runtime to pre-install: the first run resolves Node.js → installs DSH → installs the `dlient-chat` profile (the first run downloads dependencies and can take a few minutes).
2. Open the dsh app in dlient (or embed `Chat` in another plugin).
3. Inside the DSH UI: configure your API key under Settings → Models, then pick a Workspace to start.

### Embedding Chat

```tsx
import { PluginView } from '@dlient-open/ui'

// optional: pass a workspace (absolute directory path)
<PluginView pluginId="dsh" entry="Chat" componentProps={{ workspace: '/path/to/project' }} />
```

- `pluginId` is the running instance id of dsh (`dsh` for an installed plugin, `dsh@dev` for a dev instance).
- On mount, `Chat` calls `dsh.chatStart` (idempotent + single-flight in the worker: concurrent mounts install/start once) and embeds `http://127.0.0.1:<port>[?workspace=…]` with `Webview`.
- `workspace?: string` is (1) passed to dsh as `--workspace` (registers a real workspace group) and (2) appended to the page URL as `?workspace=…` (the client selects it). Takes effect when the service **starts**; changing it while running requires `dsh.chatStop` and a restart.
- `visible?: boolean` (default true) — pass `false` to hide the embedded Webview **without unmounting** (the WebContentsView is removed from the window layer while its webContents stays alive; nothing reloads).
- Loading / failure states (with a retry button) are rendered by `Chat` itself.

## Exported Methods

| Method | Description |
|--------|-------------|
| `dsh.start` | Ensure Node.js + DSH, start the `dsh web` service and return the URL |
| `dsh.stop` | Stop the `dsh web` service and restore the user's `settings.yaml` |
| `dsh.status` | Query the `dsh web` service status (phase / url / error) |
| `dsh.chatStart` | Install the `dlient-chat` profile, start the chat service and return the URL |
| `dsh.chatStop` | Stop the chat service |
| `dsh.chatStatus` | Query the chat service status (phase / url / error) |
| `dsh.applyAppearance` | Push the host language / theme (synced into `~/.dsh/settings.yaml`) |
| `dsh.restoreAppearance` | Restore `~/.dsh/settings.yaml` (write back the user baseline) |

## Runtime & Authorization Notes

- **Install chain**: bundled Node.js → `npm -g @deepseek-ai/dsh` (which also installs `pnpm`, required by `dsh plugin`) → the inlined `@dlient/dsh-chat-ui` assets are written to `<DATA>/chat-ui` and installed into the `dlient-chat` profile.
- **Sandbox compliance**: the worker runs inside the host sandbox (Node Permission Model) and cannot touch files directly — every file / process / port operation goes through host-api.
- **Runtime authorization**: reading/writing `~/.dsh/settings.yaml` (and the `settings.dlient.yaml` backup) requires a one-time grant (`permission.request`) — **only these two files**. If denied, language / theme sync is skipped (graceful degradation) and the service still starts.
- **Command authorization**: the manifest declares `spawnCmds: ["CMD_NODE", "CMD_NPM", "CMD_PNPM"]` — host-resolved **command aliases** rather than absolute paths; the grant is recorded against the alias.
- **Chat lifecycle**: `start()` is idempotent and single-flight; there is **no auto-stop** — the service ends only on explicit `chatStop`, worker exit (plugin disable/uninstall/overlay reinstall, host quit), or a crash. Timeouts exist only for startup/execution (e.g. 120 s port-readiness, 300 s installs), never as an idle killer.

## Plugin layout

```
dsh/
├─ assets/            icon, user-facing docs (index.md / en-US / zh-CN), SKILL.md,
│                     mcp.json, dsh-chat-ui (inlined into dist/worker.js at build time)
├─ src/
│  ├─ main/           worker (Node): chat.ts / dsh-runtime.ts / index.ts
│  └─ renderer/       UI (React + Vite): App.tsx / Chat.tsx / i18n.ts / styles.css
├─ script/            build-clean / build-worker / make-dlient
└─ package.json       dlient manifest (type: app)
```

The built-in `assets/dsh-chat-ui` is inlined into `dist/worker.js` **at build time** via the esbuild virtual module `dlient:chat-assets`, so nothing is read from the plugin install directory at runtime (the manifest needs no `fsDirs` read grant; the directory stays in the repo as the build source).

## Development

```bash
npm install          # deps from the official registry
npm run dev          # vite build --watch + worker build --watch (concurrently)
npm run build        # build:ui + build:worker
npm run pack         # build + script/make-dlient.mjs → dsh-<version>.dlient
```

## Dependencies & Permissions

- **Shared packages**: `@dlient-open/ui` (components & `Webview`), `@dlient-open/api-bridge`, `@dlient-open/i18n`, `@dlient-open/plugin-sdk` (worker RPC) — resolved from the host's SystemJS shared instance; the `Webview` component needs **no webview permission** (it uses the view-bound client injected by `PluginView`).
- **Host-api**: `nodejs.resolveRuntime` / `nodejs.install`, `child.spawn` / `child.execFile`, `net.getFreePort` / `net.probePort`, `fs.read` / `fs.mkdir` / `fs.write` / `fs.delete`, `app.getPath`, `permission.request`, `log.write`, `i18n.getLocale`.
- **Skills**: see [assets/SKILL.md](assets/SKILL.md) for the AI Agent skill provided by this plugin.

## License

Part of the dlient open-source ecosystem. See the repository root `LICENSE`.
