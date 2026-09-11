# Creating a Plugin (scaffold, template, dev workflow)

## 1. Scaffold

Use the official open-source scaffolder (single template source: `plugin-demo`):

```bash
npx @dlient-open/create-plugin my-plugin                   # create ./my-plugin
npx @dlient-open/create-plugin my-plugin --name "My Plugin"  # display name (default = id)
npx @dlient-open/create-plugin my-plugin --dir ~/dev        # target directory
npx @dlient-open/create-plugin my-plugin --native-host      # native module via the official-Node child (native-host, no rebuild)
npx @dlient-open/create-plugin my-plugin --native           # native module vendored + @electron/rebuild (per platform)
```

There is no `--port` / `--devPort` and no `--asar` in the open-source scaffold: hot reload is an **output-level watch** (see §4), and the build output is always a plain `dist/` directory (no asar / plugin.json).

The scaffold does **not** run `npm install` and does **not** create a git repository. After scaffolding, `cd` into the plugin and install deps yourself.

- Plugin ids allow only lowercase letters, digits and hyphens (must start with a lowercase letter).
- Open source has **no Market and no Dev-Tools entry**: to run a plugin you either use the repo dev-source layout (see §4) or build a `.dlient` and import it from the host console ("Import plugin").

## 2. Template directory tree

The template mirrors the open-source `plugin-demo` template (see `app/packages/create-plugin/templates/plugin-demo`):

```
my-plugin/
├── package.json              # manifest (dlient sub-object)
├── vite.config.ts            # createPluginViteConfig preset (SystemJS output)
├── tsconfig.json
├── skills/
│   └── SKILL.md              # optional AI-agent skill doc (stays under skills/)
├── assets/                   # assembled public assets
│   ├── icon.svg              # required icon (manifest dlient.icon; picked by the plugin id initial)
│   ├── index.md              # intro (default / English)
│   ├── index.zh-CN.md        # Chinese intro (optional)
│   ├── index.en-US.md        # English intro variant (optional)
│   └── mcp.json              # optional MCP tool descriptions (moved from the root)
├── script/
│   ├── build-clean.mjs       # cleans dist/
│   ├── build-worker.mjs      # → dist/worker.js (+ dist/native-host.js when src/native-host/ exists)
│   ├── make-dlient.mjs       # npm run pack → <id>-<version>.dlient (local, unsigned)
│   └── build-native.mjs      # only when scaffolded with --native
└── src/
    ├── main/index.ts         # worker entry
    ├── native-host/          # only with --native-host (index.ts)
    └── renderer/             # UI: App.tsx / i18n.ts / styles.css / env.d.ts
```

## 3. Install & build

```bash
cd my-plugin
npm install
npm run build        # UI → dist/remoteEntry.js (+ style.css/assets); worker → dist/worker.js
```

Standard scripts (from the template `package.json`):

| Command | Effect |
| --- | --- |
| `npm run build` | `build-clean` → `build:ui` → `build:worker` (+ `build:native` with `--native`) |
| `npm run build:ui` | `vite build` → `dist/remoteEntry.js` (System.register) + CSS |
| `npm run build:worker` | `node script/build-worker.mjs` → `dist/worker.js` (+ `dist/native-host.js` when present) |
| `npm run dev:watch` | UI rebuild on change (`vite build --watch`) |
| `npm run dev:watch:worker` | worker rebuild on change (`build-worker.mjs --watch`) |
| `npm run dev` | run both watch commands concurrently (output-level watch) |
| `npm run pack` | `npm run build && node script/make-dlient.mjs` → `<id>-<version>.dlient` at the plugin root (also supports `node script/make-dlient.mjs --version x.y.z` / `--name x.dlient`) |

The build output is always a **plain `dist/` directory** (`remoteEntry.js` / `worker.js` / …) — there is no `asar` packaging and no `plugin.json` form. `.dlient` is an ordinary (store-compressed) zip containing `package.json` (with `dlient.source='local'` / `dlient.system=false` patched at pack time), `assets/`, `skills/` and `<dist>/` (excluding `dist/node_modules`); no signature is attached — the host signs locally after import (see §5).

## 4. Run & debug

Open source has no Market / Dev-Tools; run against the host in one of two ways:

1. **Repo dev-source flow (dev)** — place the plugin source under `dlient-open/plugins/<pluginId>` (the host's dev source dir; `source: 'dev'`, `@dev` instances are signature-exempt). Run `npm run dev` (or the two watch commands) — it watches the output (`vite build --watch` + worker esbuild `--watch`). Output changes take effect after you reopen / reload the host; there is **no dev-server port**.
2. **Import flow (installed)** — `npm run pack`, then in the host console use **"Import plugin"** and pick the `.dlient`. The host shows a confirm dialog (permissions tab + preInstall dependencies tab) and deep-installs declared `preInstall` deps before/while installing.

Logs:

- worker & UI write to `USER_DATA/plugin-data/<pluginId>/logs/main.log` (JSONL, one JSON per line); `USER_DATA` = `~/.dlient-open`.
- In the repo dev flow you can tail the file directly or pull lines through the log APIs.

Permission troubleshooting:

- a denied call throws `PERMISSION_DENIED` (`-2107`); the host writes a `security` audit line;
- dev-mode escapes (not for production): `DLIENT_DISABLE_PERMISSION=1`, `DLIENT_DISABLE_FS_ENFORCE=1`.

## 5. Distribution & install (open-source, local only)

There is **no market upload, no review, no server-side / platform signature and no organization endorsement** in the open-source host. Distribution is local:

**A. Package a `.dlient`**

Run `npm run pack` inside the plugin project: it builds first, then `make-dlient.mjs` produces `<id>-<version>.dlient` at the plugin root (patched manifest copy: `dlient.source='local'`, `dlient.system=false`; `assets/` + `skills/` + `<dist>/` included, `dist/node_modules` excluded). Share the file with others or import it yourself.

**B. Import (host console → "Import plugin")**

1. Pick the `.dlient`; the host parses the manifest and shows a **confirm dialog**: a permissions tab (each declared permission listed with its install-risk dot: `default` grey / `warn` orange / `dangerous` red) and a dependencies tab (the `preInstall` entries).
2. **Deep install**: if the manifest declares `preInstall`, the host recursively installs each dependency first — npm (`semver` → pull the npm package and find its `.dlient` at the package root / `pack/` / `dist/`), GitHub (latest Release's `*.dlient` asset), or a direct `.dlient` URL.
3. The plugin is extracted into `USER_DATA/plugins/<id>` (`~/.dlient-open/plugins/…`), with the manifest rewritten to `source='local'`, `system=false`.
4. **Local integrity signing**: after landing, the host signs the directory with its embedded Ed25519 key and writes `signature.json` (format=1; `files` covers only `package.json` + `dist/**` as `sha256:<hex>`). On startup / protocol load the host verifies it; repo dev-source dirs (`@dev`) are skipped, and plugins without a `signature.json` (legacy/historical imports) are allowed.

Installed plugins live in `~/.dlient-open/plugins/`; the host user-data root is `~/.dlient-open`.

## 6. Common troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `permission denied … -2107` | Missing `manifest.permissions` entry or resource grant. Add the permission or authorize through the dialog / grant page. |
| Worker never starts / status `starting` forever | Build missing `dist/worker.js`, or worker blocks the event loop (heartbeat timeout). |
| UI blank / styles missing | `remoteEntry.js` not built; check `dist/` and the `dlientOpen://` asset log lines. |
| Type inference surprising | `type` defaults to `app`; declare `type` explicitly for `full` / `worker` / `ui`. |
| Import fails on a missing dependency | The plugin declares `preInstall` / `dependencies` for a plugin that is not installed; import that dependency first (or use a `.dlient` that brings it via deep install). |
| Plugin shows "not ready" for `nodejs` | `dlient.nodeVersion` (or a `nodejs` dependency) triggers readiness gating; the host auto-installs the bundled Node runtime, or you install it via the Node dialog. |
