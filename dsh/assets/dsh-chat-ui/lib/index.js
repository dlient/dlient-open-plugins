// Host half of the `dsh-chat-ui` package.
//
// Two jobs, both on the node side:
//   1. Register the `--workspace <path>` directory as a durable Workspace at
//      startup. A workspace created this way goes through the host
//      workspaceRegistry, which persists it (the browser-side
//      workspaces.create({path}) only keeps a transient view, so a URL-created
//      workspace never becomes a real group and its sessions fall into
//      "Ungrouped"). Registering here makes it a proper, persisted group.
//   2. Be a loader entry for the client bundle (the `dsh.client` declaration)
//      so the browser roster composes it into window.__DSH_BOOT__.
//
// The browser-side surface (sidebar collapse, the product's own hero
// agent-preset chip as the mode selector, window.setTheme / setLanguage,
// ?workspace= / ?theme= / ?language=) lives in ./client.js.
export const name = "dsh-chat-ui";
export const inject = ["webStartup", "workspaceRegistry"];

export function apply(ctx) {
  const workspace = ctx.webStartup.workspace;
  if (workspace === void 0) return;
  void ctx.workspaceRegistry.create(workspace).then(() => {
    console.log(`dsh-chat-ui: registered workspace ${workspace}`);
  }, (error) => {
    console.error(`dsh-chat-ui: could not register workspace ${workspace}: ${error instanceof Error ? error.message : String(error)}`);
  });
}
