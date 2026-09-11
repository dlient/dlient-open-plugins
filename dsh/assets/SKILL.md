---
name: "dsh"
description: "Runs the DeepSeek Harness (dsh) AI Agent web UI in dlient: starts/stops the dsh service and reports its URL. Invoke when the task needs to launch or manage a DeepSeek Harness session."
---

# dsh — DeepSeek Harness

dsh embeds the DeepSeek Harness (dsh) AI Agent web UI inside dlient. The worker manages the Node.js runtime and the `dsh web` service; the renderer displays it in a `Webview`. All interactions go through cross-plugin RPC (`rpc.plugin.invoke('dsh', '<method>', [args])`).

## When to Use

- Start the DeepSeek Harness service and obtain its access URL.
- Query whether the service is running.
- Stop the service and clean up the PID file / port.

## Methods

| Method | Args | Returns | Description |
|--------|------|---------|-------------|
| `dsh.start` | — | `{ url?: string }` | Ensure Node.js + DSH, start `dsh web`, return the URL |
| `dsh.stop` | — | `{ ok: boolean }` | Stop the running service, clean up PID file / port |
| `dsh.status` | — | `{ running: boolean, url?: string }` | Query service status |

## Examples

```ts
const { url } = await rpc.plugin.invoke('dsh', 'dsh.start')
const status = await rpc.plugin.invoke('dsh', 'dsh.status')
await rpc.plugin.invoke('dsh', 'dsh.stop')
```

## Notes

- First start may download/install Node.js (via the `nodejs` plugin) and `@deepseek-ai/dsh`, which takes a while.
- Requires the `nodejs` system plugin to be installed.
