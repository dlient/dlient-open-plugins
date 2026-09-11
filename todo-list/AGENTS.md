# AGENTS.md

This project is a **dlient plugin** (`todo-list` — "todo-list"), scaffolded by
`@dlient-open/create-plugin`. dlient is an Electron desktop host that loads plugins; a plugin may have a
**worker** (Node, runs in an Electron `utilityProcess`) and/or a **UI** (React bundle loaded by the host
renderer). Workers are sandboxed: every file / process / network operation goes through **host-api** calls
validated by the main process.

## Read `.agent/` first

Before writing or changing code, read the docs under `.agent/`:

| File | Covers |
| --- | --- |
| `.agent/SKILL.md` | Plugin development guide — concepts, workflow, manifest, host-api, permissions |
| `.agent/references/create-plugin.md` | Scaffolding flags, template tree, dev workflow, packaging & import |
| `.agent/references/manifest-schema.md` | Every `dlient.*` manifest field, with a commented example |
| `.agent/references/host-api-reference.md` | Per-method host-api docs (params, types, examples) |
| `.agent/references/permission-model.md` | Sandbox bans, resource grants, unified confirm dialogs |
| `.agent/references/worker.md` | Worker: SDK API, RPC, logging, subprocess handles |
| `.agent/references/ui.md`, `ui-api.md` | UI: `@dlient-open/ui` components, hooks, i18n, theming |
| `.agent/references/native-host.md` | Native modules via a dedicated full-permission Node child |
| `.agent/references/dev-standards.md` | Worker + UI coding standards |

## Layout

| Path | Purpose |
| --- | --- |
| `src/main/index.ts` | Worker entry — calls the host via `rpc.*` |
| `src/renderer/App.tsx` | UI entry — built to `dist/remoteEntry.js` (SystemJS) |
| `src/native-host/index.ts` | Optional native-module host (only when scaffolded with `--native-host`) |
| `package.json` → `dlient` | The plugin manifest (never a separate `plugin.json`) |
| `script/` | Build scripts (`build-worker.mjs`, `make-dlient.mjs`, …) |

## Commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Watch build: UI (`vite build --watch`) + worker (`esbuild --watch`) |
| `npm run build` | One-off build → `dist/remoteEntry.js` + `dist/worker.js` |
| `npm run pack` | Produce a distributable `.dlient` package |

## Ground rules

- Declare **every** host-api call in `dlient.permissions` (e.g. `fs.read`, `child.spawn`, `app.getPath`);
  resource access additionally needs `fsDirs` / `spawnCmds`, or a runtime grant.
- The worker is sandboxed (Node Permission Model): no direct `node:fs` / `node:child_process`, no sync
  blocking I/O — use `rpc.*` instead.
- UI must use `@dlient-open/ui` components and support light/dark themes + i18n (`src/renderer/i18n.ts`).
