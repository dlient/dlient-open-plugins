# Dev Tools

A dev-plugin management & preview toolbox for dlient — create, register, build, preview, pack and troubleshoot dev plugins from inside the host UI. It does not replace your editor, but it removes the friction of "edit → rebuild → restart the host" when developing plugins.

> **English** · [简体中文](README.zh-CN.md)

## Features

- **Create from template** — runs `@dlient-open/create-plugin` through the host-resolved `CMD_NPM` alias (`npm exec --yes …`, no scaffold is bundled inside the plugin), then installs dependencies into the new directory. With no mode flag this creates a **UI-only** plugin (the scaffolder's `default` mode: no worker, no `skills/`); scaffold with `--worker` / `--native-host` / `--native` if you need background or native code.
- **Register a directory** — point at an existing dev plugin dir (including `E:\dlient-open\plugins` style workspaces); it is added to the dev list and its `package.json` is watched for manifest changes.
- **Auto build & dev instances** — every entry is built with its own `npm run dev:watch`-style process; the built plugin is loaded into the host as a real *dev instance* (`pluginId@dev`) with preview, exactly as an installed plugin would behave.
- **Preview with refresh** — the left pane previews the dev plugin UI live. The refresh button reloads **only the preview** (the embedded Chat panel is not touched), and a stale-failed load recovers without restarting the host.
- **AI panel (Chat)** — the right sidebar embeds dsh's `Chat` component via `PluginView`. It is a real dsh chat surface wired to the workspace you pass. It only appears in the **preview** view (Logs / Settings stay full-width) and its divider can be dragged to resize it (default 220 px, hidden until you click the AI button); collapsing/expanding the panel hides/shows the native view without reloading it.
- **Logs** — per-entry build/dev process output, streamed into the Logs tab with a process registry.
- **Pack to `.dlient`** — one click runs the entry's own `make-dlient.mjs` (or the fallback pack path) and produces `<id>-<version>.dlient` in the plugin directory, ready to import locally.
- **Settings** — Node.js version requirement for the built-in runtime, npm registry selection (auto `npmmirror` in CN region), and per-entry environment checks (`ensureEnv`: Node → deps → manifest).

## Requirements

- dlient (open-source host) with a resolvable Node.js runtime. `dev-tools` declares `spawnCmds: ["CMD_NODE", "CMD_NPM"]` — the host resolves these **command aliases** (bundled runtime → PATH → well-known locations), so no absolute paths and no per-command prompts.
- dsh installed, if you want the AI panel to work (the panel embeds dsh's `Chat`; it degrades gracefully when dsh is absent).
- Dev plugins created from the template get their own `@dlient-open/*` dependencies from the official npm registry (no `file:` links to the host packages).

## Plugin layout

```
dev-tools/
├─ assets/            icon + user-facing docs (index.md / en-US / zh-CN)
├─ src/
│  ├─ main/           worker (Node): dev entries, build/dev processes, pack, logs
│  └─ renderer/       UI (React + Vite): Workbench / CreatePluginDialog / MarkdownEditor / Settings
├─ script/            build-clean / build-worker / make-dlient
└─ package.json       dlient manifest (type: app)
```

- **Worker** is a Node process in the host worker pool. It talks to the host through host-api (`child.spawn`, `fs.*`, `nodejs.*`, `permission.request`, …) under `fsDirs: { read/write: ["PLUGINS"] }`.
- **Renderer** is a SystemJS remoteEntry bundle. It imports `@dlient-open/ui`, `@dlient-open/api-bridge`, `@dlient-open/i18n` (resolved from the host's shared instance) plus `@dlient-open/plugin-sdk` for the worker RPC client.

## Development

```bash
npm install          # deps from the official registry
npm run dev          # vite build --watch + worker build --watch (concurrently)
npm run build        # build:ui + build:worker
npm run pack         # build + script/make-dlient.mjs → dev-tools-<version>.dlient
```

## Worker API (exposed to the renderer)

`list`, `register`, `remove`, `selectDirectory`, `checkImportable`, `changeToDev`, `getDirInfo`, `readSettings`/`writeSettings`, `readAsset`/`writeAsset`, `readMarkdown`/`writeMarkdown`, `checkNode`, `installNode`, `devCreatePlugin`, `runtimeStates`, `previewInfo`, `buildDev`, `stop`, `listBuilds`, `log`, `ensureDeps`, `checkManifest`, `ensureEnv`, `closePlugin`, `refresh` (stream), `packDlient`, `revealPath`.

## How the preview refresh works

The `refresh` stream handler rebuilds the entry, waits for a fresh bundle, and asks the host to reload the plugin instance; the renderer then remounts the preview `PluginView` with a cache-busting query. Failed `SystemJS` loads are retried on a **different URL** (the second attempt no longer hits the cached failure), and the error state is cleared before each reload — so "AI edited the code and the preview went red" recovers by simply clicking refresh, without restarting the host.

## License

Part of the dlient open-source ecosystem. See the repository root `LICENSE`.
