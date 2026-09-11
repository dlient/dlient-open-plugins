# dlient-open plugins

A collection of plugins for **dlient-open**, the open-source Electron host that loads plugins. A plugin may ship a **worker** (Node, runs in a sandboxed `utilityProcess`) and/or a **UI** (React bundle loaded by the host renderer), and every file / process / network operation goes through **host-api** calls validated by the main process.

> **English** · [简体中文](README.cn.md)

## Plugins

| Plugin | Type | Description |
| --- | --- | --- |
| [`dev-tools`](dev-tools/) | app | Dev-plugin toolbox: create from template, register a directory, auto-build, live preview, pack to `.dlient`, logs. |
| [`dsh`](dsh/) | app | Runs the DeepSeek Harness (dsh) AI agent inside dlient, with an embeddable chat surface for other plugins. |
| [`todo-list`](todo-list/) | app | A local day-by-day task timeline (start/due dates, priorities, search, progress); today is centred and data never leaves the machine. |

Each plugin is a **self-contained directory** — its own `package.json` manifest, build scripts, docs and lockfile. This repository is not an npm workspace; plugins share no root tooling and are built independently.

## Repository layout

```
plugins/
├─ dev-tools/        # 插件开发工具箱
├─ dsh/              # DeepSeek Harness AI agent
├─ todo-list/        # 待办时间轴
├─ .gitignore
├─ LICENSE           # MIT
└─ README.md / README.cn.md
```

Layout of a single plugin (see each plugin's own README for details):

| Path | Purpose |
| --- | --- |
| `package.json` → `dlient` | Plugin manifest (id / name / type / icon / permissions / expose…) |
| `src/main/` | Worker (Node, host-api via `rpc.*`) → built to `dist/worker.js` |
| `src/renderer/` | UI (React + Vite) → built to `dist/remoteEntry.js` (SystemJS) |
| `script/` | Build scripts (`build-clean` / `build-worker` / `make-dlient`) |
| `assets/` | Icon + plugin description (`index.md` / `index.en-US.md` / `index.zh-CN.md`) |
| `AGENTS.md`, `.agent/` | Coding-agent guide and dlient plugin development docs (where present) |

## Requirements

- **dlient-open** — the open-source host that loads and runs these plugins.
- **Node.js + npm** — for building, and as a resolvable runtime for plugins that declare `spawnCmds`.
- **dsh** — only if you want the AI panel inside `dev-tools` (it degrades gracefully when dsh is absent).

## Development

Build each plugin in its own directory:

```bash
cd todo-list
npm install
npm run dev      # watch build (UI + worker)
npm run build    # typecheck → UI → worker, output to dist/
npm run pack     # build + produce <id>-<version>.dlient
```

Common scripts, defined per plugin:

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Watch build: UI (`vite build --watch`) + worker (`esbuild --watch`) |
| `npm run build` | Typecheck + build UI + worker → `dist/` |
| `npm run pack` | Build + package to `<id>-<version>.dlient` (unsigned) |

## Install a built plugin

In dlient-open, use the bottom-left **“＋ Import plugin”** entry and pick the `.dlient` package; the plugin then appears under “Installed apps”.

## Contributing

Changes land through pull requests — see [CONTRIBUTING.md](CONTRIBUTING.md) for the branch, commit and review conventions, and [ci.yml](.github/workflows/ci.yml) for the checks CI runs on every PR.

## License

[MIT](LICENSE) © 2026 dlient contributors
