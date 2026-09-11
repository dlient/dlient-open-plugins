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
