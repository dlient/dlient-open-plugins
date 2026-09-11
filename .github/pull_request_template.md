<!-- One plugin per pull request. If more than one box below is ticked, consider splitting. -->

## Plugin(s) affected

- [ ] `dev-tools`
- [ ] `dsh`
- [ ] `todo-list`

## What does this PR do?

<!-- One or two sentences: what changes, and why. -->

## Type of change

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `chore` — tooling / dependencies / CI / housekeeping

## Adding a new plugin?

Only for a brand-new plugin — leave the unticked list above alone and name the plugin here instead.
Skip this whole section when changing an existing plugin.

- [ ] Directory name equals `dlient.id`, and the id is lowercase `a-z` / `0-9` / `-` only
- [ ] `package-lock.json` is committed (CI installs with `npm ci`)
- [ ] `"typecheck": "tsc --noEmit"` exists in the plugin's `package.json`
- [ ] `README.md` + `README.cn.md` and `LICENSE` are included
- [ ] A row was added to the plugin tables in the root `README.md` and `README.cn.md`
- [ ] `dlient.permissions` lists only what the plugin actually uses
- [ ] `npm ci && npm run typecheck && npm run build` passes in the new plugin directory

## Checklist

- [ ] `npm ci && npm run typecheck && npm run build` passes in every affected plugin
- [ ] Commits follow conventional commits with the plugin id as scope (e.g. `feat(todo-list): …`)
- [ ] Every new host-api call is declared in `dlient.permissions`, and the permission is as narrow as possible (`fsDirs` / `spawnCmds` for resource access)
- [ ] If an exported method changed, `dlient.expose`, the README method table, `skills/SKILL.md` and `assets/mcp.json` are updated together
- [ ] UI changes register both `zh-CN` and `en-US`, and work in light and dark theme
- [ ] No `node_modules/`, `dist/` or `*.dlient` artifacts are committed

## Verification

<!-- How did you verify this? Commands run, plugin imported into dlient, screenshots, … -->

## Related issues

<!-- Closes #… -->
