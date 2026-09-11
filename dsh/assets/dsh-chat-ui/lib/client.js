// Browser half of the `dsh-chat-ui` package.
//
// This is a dsh client bundle: a lazy CJS module the client module system
// loads via window.__ModuleLoader__.load({id, factory}). The factory's
// `module.exports` is the Cordis client plugin (see the ui-theme bundle for
// the same shape). It runs in the browser, so `window` / `document` /
// `URLSearchParams` / `setTimeout` are available; it must NOT use JSX, import,
// or TypeScript. It registers no React components — every customisation is a
// stylesheet plus runtime-service calls — so it needs no `react` require.
//
// The plugin customises the served `dsh web` surface into a single-column
// `dsh chat` surface:
//   1. Collapse the left sidebar so only the chat column renders.
//   2. Read `?workspace=<path>` and open that workspace without a picker.
//   3. Read `?theme=` / `?language=` and apply them on load.
//   4. Keep the product's OWN agent-preset chip as the mode selector. It is the
//      `conversation.hero.agentPreset` seat (ui-agent-preset's AgentPresetSeat),
//      rendered inside the hero workspace row, and the shell renders that row
//      only in the hero phase — a blank session, or no session at all — which
//      is exactly where choosing a preset still has an effect (a running
//      session keeps the composition it began with). This plugin therefore
//      renders no mode selector of its own, and no longer restricts the roster
//      to `standard` + `code`: that needs a host-side allowlist in
//      `dsh-agent-presets`, whose `roots` config is directory-level only.
//   5. Export window.setTheme(id) / window.setLanguage(id).
//   6. Hide the conversation top strip (breadcrumbs / session title / tabs)
//      above the message list, so only messages + composer remain.
//   7. Hide the in-flow session-history load-failure banner
//      ("历史加载失败：…（internal）") when a session log cannot be loaded.
//   8. When ?workspace= is present, hide only the hero row's workspace-picker
//      trigger, leaving the product's agent-preset chip beside it usable.
window.__ModuleLoader__.load({
  id: "@dlient/dsh-chat-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var PLUGIN_ID = "@dlient/dsh-chat-ui";

    // Collapse the left column entirely so only the chat column renders.
    //
    // The layout frame (dsh-client-ui-layout, AppFrame) is a 3-track grid
    // `sidebar | center | details` whose track widths are set in an inline
    // grid-template-columns style, so a stylesheet `!important` rule wins.
    //
    // IMPORTANT: do NOT use `display:none` on the columns. `display:none`
    // removes a grid child from flow, so the grid no longer counts the sidebar
    // as track 1; the center column then lands in the 0px sidebar track and
    // collapses to width 0 (a blank page). Only the absolutely-positioned drag
    // handles may be `display:none`.
    var HIDE_SIDEBAR_CSS = [
      ".pI_x6G_frame{grid-template-columns:0 minmax(0, 1fr) 0 !important}",
      ".pI_x6G_sidebarCol{border-right:none !important}",
      ".pI_x6G_detailsCol{border-left:none !important}",
      ".pI_x6G_handle{display:none !important}"
    ].join("\n");

    // ConversationRoot.module.css (client-ui-conversation): the header strip
    // that sits ABOVE the message flow — breadcrumbs / session title /
    // utilities / chat tabs. Hide it so the surface shows only the message
    // list and the composer.
    var HIDE_CONVERSATION_TOP_CSS = ".wSkVaW_header{display:none !important}";

    // ChatView.module.css: the in-flow banner rendered when a session's
    // history cannot be loaded ("历史加载失败：<message>（internal）"). Hide it.
    var HIDE_HISTORY_ERROR_CSS = ".Md3f7G_openError{display:none !important}";

    // The hero row the blank-session / no-session phase renders ABOVE the
    // composer input (ConversationRoot.module.css `.wSkVaW_heroWorkspaceRow`,
    // `display:flex`): WorkspaceChip (`.pXSMma_workspace`, HeroShell.module.css)
    // + the `conversation.hero.workspace` menu seat + the
    // `conversation.hero.agentPreset` chip. When ?workspace= already fixed the
    // workspace, only the picker TRIGGER is redundant, so only that trigger is
    // hidden — hiding the whole row would take the product's agent-preset chip
    // (this surface's mode selector) down with it. The
    // `conversation.hero.workspace` seat renders the picker menu alone, which
    // cannot be opened once its trigger is gone.
    var HIDE_WORKSPACE_CHIP_CSS = ".wSkVaW_heroWorkspaceRow>.pXSMma_workspace{display:none !important}";

    function injectStyle(css, label) {
      if (typeof document === "undefined") return function () {};
      var tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      if (label) tag.dataset.pluginCss = label;
      tag.textContent = css;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    // Defence-in-depth for the history-load error row. The class rules above
    // are exact for the current prebuilt frontend; if the frontend is rebuilt
    // (new class hashes) they silently stop matching. This guard additionally
    // hides the row by content: ChatView renders it as a DIRECT child of the
    // `[data-chat-flow]` column when history loading fails, so only direct
    // children of a chat flow are ever inspected (deep message content is not).
    function installHistoryErrorGuard() {
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") return function () {};
      var FLOW = "[data-chat-flow]";
      // zh label from chat.loadError; "history unavailable" is the RPC error
      // text embedded in {message} in every locale; "Failed to load history"
      // covers an English UI rebuild.
      var ERROR_TEXT = /history unavailable|历史加载失败|Failed to load history/i;
      function rowMatches(el) {
        return el.nodeType === 1 && el.parentElement !== null && el.parentElement.matches(FLOW) && ERROR_TEXT.test(el.textContent || "");
      }
      function hideRow(row) {
        if (row.getAttribute("data-dsh-chat-hid-error") === "1") return;
        row.setAttribute("data-dsh-chat-hid-error", "1");
        row.style.display = "none";
      }
      function scanFlows() {
        var flows = document.querySelectorAll(FLOW);
        for (var i = 0; i < flows.length; i++) {
          var children = flows[i].children;
          for (var j = 0; j < children.length; j++) {
            var child = children[j];
            if (child.parentElement.matches(FLOW) && rowMatches(child)) hideRow(child);
          }
        }
      }
      function onMutations(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var nodes = mutations[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var el = nodes[j];
            if (el.nodeType !== 1) continue;
            // A whole flow column was mounted: scan it once.
            if (el.matches && el.matches(FLOW)) { scanFlows(); continue; }
            if (rowMatches(el)) hideRow(el);
          }
        }
      }
      var observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      scanFlows();
      return function () { observer.disconnect(); };
    }

    // Open the workspace from `?workspace=<path>`:
    //   1. register the path as a Workspace (idempotent) and wait for it to be
    //      visible in the projected workspace list;
    //   2. if that workspace already has sessions, open the LATEST one;
    //   3. otherwise connect its blank session (creating one if needed) and open it.
    // The workspace must be registered (persisted) for this to group correctly;
    // start the server with `dsh --profile dlient-chat --workspace <path>` to register it.
    function openWorkspaceByPath(workspaces, sessions, path) {
      var attempts = 0;
      var maxAttempts = 60; // ~18s at 300ms
      function latestOf(s) { return s && typeof s.updatedAt === "number" ? s.updatedAt : 0; }
      function attempt() {
        attempts += 1;
        return workspaces.create({ path: path }).then(function (view) {
          var items = (workspaces.list.getSnapshot().items) || [];
          var wItem = items.find(function (it) { return it.path === path || (view && it.workspaceId === view.id); });
          if (wItem === undefined) throw new Error("workspace not visible yet");
          var byId = sessions.list.getSnapshot().byId || {};
          var accounted = (wItem && Array.isArray(wItem.sessionIds)) ? wItem.sessionIds : (Array.isArray(view.sessionIds) ? view.sessionIds : []);
          var candidates = [];
          for (var i = 0; i < accounted.length; i++) {
            var s = byId[accounted[i]];
            if (s) candidates.push(s);
          }
          if (candidates.length < accounted.length && attempts < 20) throw new Error("workspace sessions not ready yet");
          candidates.sort(function (a, b) { return latestOf(b) - latestOf(a); });
          var latest = candidates[0];
          if (latest !== undefined) {
            if (typeof console !== "undefined" && console.log) console.log("dsh-chat-ui: workspace " + path + " -> opening latest session " + latest.id);
            sessions.open(latest.id);
            return;
          }
          if (typeof console !== "undefined" && console.log) console.log("dsh-chat-ui: workspace " + path + " has no sessions; connecting a blank one");
          return workspaces.connectWorkspace(wItem.workspaceId).then(function (sessionId) {
            sessions.open(sessionId);
          });
        });
      }
      function loop() {
        return attempt().catch(function (err) {
          if (attempts >= maxAttempts) throw err;
          return new Promise(function (r) { setTimeout(r, 300); }).then(loop);
        });
      }
      return loop().catch(function (err) {
        if (typeof console !== "undefined" && console.error) console.error("dsh-chat-ui: workspace open failed: " + (err && err.message ? err.message : String(err)));
      });
    }

    function apply(ctx) {
      try {
        ctx.effect(function () { return injectStyle(HIDE_SIDEBAR_CSS); }, "dsh-chat-ui: collapse-left-column");
        ctx.effect(function () { return injectStyle(HIDE_CONVERSATION_TOP_CSS); }, "dsh-chat-ui: hide-conversation-top");
        ctx.effect(function () { return injectStyle(HIDE_HISTORY_ERROR_CSS); }, "dsh-chat-ui: hide-history-error");
        ctx.effect(installHistoryErrorGuard, "dsh-chat-ui: history-error-guard");

        var search = (typeof window !== "undefined" && window.location && window.location.search) || "";
        var params = new URLSearchParams(search);

        window.setTheme = function (id) { var theme = ctx.get("theme"); if (theme !== undefined) theme.setTheme(id); };
        window.setLanguage = function (id) { var locale = ctx.get("locale"); if (locale !== undefined) locale.setLocale(id); };

        if (params.get("theme")) window.setTheme(params.get("theme"));
        if (params.get("language")) window.setLanguage(params.get("language"));

        var workspaceParam = params.get("workspace");

        // ?workspace= already fixed the workspace: the hero row still offers a
        // workspace picker above the composer input, so hide that trigger —
        // only the trigger, never the row, which also carries the product's
        // agent-preset chip (this surface's mode selector).
        if (workspaceParam) {
          ctx.effect(function () { return injectStyle(HIDE_WORKSPACE_CHIP_CSS); }, "dsh-chat-ui: hide-workspace-chip");
        }

        ctx.inject(["sessions", "workspaces"], function (scope) {
          // URL-driven workspace.
          if (workspaceParam && scope.get("workspaces") !== undefined) {
            if (typeof console !== "undefined" && console.log) console.log("dsh-chat-ui: opening workspace from URL: " + workspaceParam);
            openWorkspaceByPath(scope.get("workspaces"), scope.get("sessions"), workspaceParam);
          }
        });
      } catch (error) { var log = typeof console !== "undefined" && console.error ? console.error : function () {}; log("dsh-chat-ui: apply failed", error); }
    }

    exports.name = "dsh-chat-ui";
    exports.apply = apply;
    return module.exports;
  }
});
