// Command-line provider for the `dsh chat` profile.
//
// This is a superset of `@deepseek-ai/dsh-web-app/startup`: it parses the same
// web flag family (--host / --port / --no-open / --trusted-host) and ALSO
// --workspace <path>, then publishes the immutable values under the SAME
// `webStartup` service key (with an extra `workspace` field) so the existing
// webserver and web-runtime rows keep working unchanged. `--workspace` tells
// the host to register that existing directory as a workspace at startup, which
// persists it properly (the harness only keeps a transient view when a
// workspace is created from the browser).
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/** Stable Cordis plugin name. */
export const name = "chat-startup";
/** Services required before the flags can be resolved. */
export const inject = ["cmdlineArgs"];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = "webStartup";

function chatCommand() {
  return new Command()
    .name("dsh --profile dlient-chat")
    .description("Serve the DeepSeek Harness chat UI.")
    .helpOption("-h, --help", "show this help")
    .option("--host <host>", "bind host")
    .option("--no-open", "do not open the Web UI in the default browser")
    .option("--port <port>", "listen port; pass 0 to let the OS pick a free one")
    .option("--trusted-host <authority...>", "extra authority the /api browser-trust fence accepts (host or host:port; repeatable)")
    .option("--workspace <path>", "register this existing directory as the workspace at startup")
    .addHelpText("after", `
Examples:
  dsh --profile dlient-chat                                    serve on the composed host and port
  dsh --profile dlient-chat --port 8080 --workspace E:\\hzd    serve on 8080 and register E:\\hzd as a workspace
`);
}

export function apply(ctx) {
  const program = chatCommand();
  program.action(() => {
    const options = program.opts();
    if (options.host === "0.0.0.0") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead");
    if (options.port !== void 0 && !/^\d+$/.test(options.port)) program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...(options.host !== void 0 && { host: options.host }),
      ...(options.port !== void 0 && { port: Number(options.port) }),
      trustedHosts: options.trustedHost ?? [],
      ...(options.workspace !== void 0 && { workspace: options.workspace })
    });
  });
  parseCmdline(ctx, program);
}
