# Contributing

This repository hosts several **independent** dlient plugins. Each one is a self-contained npm
project with its own manifest, dependencies and lockfile — there is no root `package.json` and no
npm workspace, so every command runs from inside a plugin directory.

## Ground rules

- **`main` is protected.** Direct pushes are rejected; every change lands through a pull request
  that passes CI.
- **One plugin per pull request.** If a change spans several plugins, split it into separate PRs so
  each one can be reviewed, released and reverted on its own.
- **`package-lock.json` is committed** (CI uses `npm ci`). Never commit `node_modules/`, `dist/` or
  `*.dlient` build artifacts — they are covered by `.gitignore`.

## Workflow

1. Branch off `main`:

   ```bash
   git switch -c feat/todo-list-recurring-tasks main
   ```

2. Make the change inside the plugin directory and run the same checks CI runs:

   ```bash
   cd todo-list
   npm ci
   npm run typecheck
   npm run build
   ```

3. Commit with a [conventional commit](https://www.conventionalcommits.org/) message, using the
   plugin id as the scope:

   ```text
   feat(todo-list): add recurring tasks
   fix(dsh): keep the chat session alive across reloads
   docs(dev-tools): document the pack step
   ```

4. Push the branch and open a pull request against `main`. Fill in the PR template — it asks which
   plugin is affected and tracks the plugin-specific requirements below.

5. Once CI is green and the review is approved, merge with **squash merge**. The head branch is
   deleted automatically.

## Branch naming

| Prefix | Use for |
| --- | --- |
| `feat/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `chore/` | Tooling, dependencies, CI, repository housekeeping |

## Plugin-specific requirements

A plugin runs inside the dlient host: its worker is sandboxed and its UI shares the host's React,
i18n and theming. That makes a few things review-critical:

- **Permissions.** Every host-api call must be declared in `dlient.permissions`; resource access
  additionally needs `fsDirs` / `spawnCmds`. Declare the narrowest permission that works — a PR that
  widens permissions needs an explicit explanation in the description.
- **Keep the contract in sync.** When you add or remove an exported method, update `dlient.expose`
  in `package.json`, the method table in the plugin's `README.md`, `skills/SKILL.md` and
  `assets/mcp.json` in the same PR.
- **UI conventions.** Register both `zh-CN` and `en-US` in the plugin's `i18n.ts`, and never hardcode
  light/dark colors — derive them from the host's theme variables so both themes work.
- **Manifest.** `dlient.*` lives in the plugin's `package.json` (there is no separate
  `plugin.json`), and the packaged `.dlient` file is generated from it.

## Adding a new plugin

A plugin lives in a top-level directory named after its id: the host's dev-source flow loads
`<plugins>/<pluginId>`, so the **directory name must equal `dlient.id`**, and the id may only
contain lowercase letters, digits and hyphens (starting with a letter).

1. Scaffold it from the official template:

   ```bash
   npx @dlient-open/create-plugin my-plugin --name "My Plugin"
   ```

2. The scaffold creates neither a git repository nor dependencies, and it does not produce
   everything this repository expects. Complete the plugin before opening the PR:

   | Missing after scaffolding | Why it is required here |
   | --- | --- |
   | `package-lock.json` | CI installs with `npm ci`, which fails without a lockfile — run `npm install` and commit it |
   | `"typecheck": "tsc --noEmit"` in `package.json` | CI runs `npm run typecheck` for every plugin |
   | `README.md` and `README.cn.md` | Plugin documentation, structured like the existing plugins |
   | `LICENSE` | MIT, matching the repository |
   | A row in the root `README.md` and `README.cn.md` plugin tables | How users find the plugin |

   The `package.json` must carry the `dlient` manifest (`dlient.id` / `name` / `type` / `icon` /
   `permissions`) — there is no separate `plugin.json`.

3. Declare only the permissions the plugin actually uses. A new plugin asking for broad `fs.*` /
   `child.*` access will be sent back for revision.

4. `skills/SKILL.md` and `assets/mcp.json` are optional — include them only if the plugin exposes
   an AI skill or MCP tools.

No CI change is needed: `.github/workflows/ci.yml` discovers plugins by the `dlient` field in
their `package.json`, so a new directory is picked up and checked automatically.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and on pushes to
`main`. For each plugin it installs with `npm ci` on Node 22, then runs `npm run typecheck` and
`npm run build`. The `ci-ok` job aggregates the per-plugin results and is the required status check —
if you add a plugin, add its directory to the workflow matrix and to the branch ruleset.

## Release

Packaging is per plugin and version-driven by that plugin's `package.json`:

```bash
cd todo-list
npm run pack     # → todo-list-<version>.dlient (unsigned)
```
