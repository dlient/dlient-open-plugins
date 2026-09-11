#!/usr/bin/env node
// Installer for the 'dsh chat' surface ('dsh --profile dlient-chat').
//
// This package IS the whole distribution: it carries both halves of the surface
// — the plugin itself (lib/index.js, lib/startup.js, lib/client.js) and the
// profile composition files that have to land in the target Harness home
// (profile/). A user downloads the checkout and runs 'node install.js' (or the
// install.sh / install.ps1 wrappers, which delegate here), and this script:
//
//   1. resolves the Harness home exactly like the dsh CLI does
//      (--dsh-home, else $DSH_HOME, else ~/.dsh);
//   2. preflights what it needs: Node, the dsh CLI, and pnpm (the
//      'dsh plugin' command is a thin pnpm forwarder);
//   3. copies profile/* into <home>/profiles/<name>/ BEFORE installing the
//      package, because 'dsh plugin' only auto-initializes a template profile
//      for an unknown name, and that template's bundle list is dsh-base alone —
//      no dsh-web-app, so no browser surface;
//   4. runs 'dsh plugin --profile <name> add file:<this package>', passing
//      DSH_HOME through the child environment so both halves always land in the
//      SAME home;
//   5. verifies the installed copy and prints how to launch it.
//
// pnpm materializes a file: directory dependency as a real directory inside the
// profile's own node_modules (hard-linking the package files, skipping
// node_modules), so this package needs no vendored dependencies: pnpm resolves
// and installs the runtime ones (commander, @deepseek-ai/dsh-cmdline) from the
// registry, and the flat fallback <home>/profiles/node_modules that the
// launcher maintains supplies the peers at boot. Because the files are
// hard-linked rather than symlinked, the checkout this ran from may be moved or
// deleted afterwards. Upgrading is re-running this script.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's directory: the distribution root (it carries profile/ too). */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
/** Directory holding the profile composition files shipped with this package. */
const PROFILE_SOURCE_DIR = join(PACKAGE_ROOT, "profile");
/** The files copied verbatim into the target profile directory. */
const PROFILE_FILES = ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml"];
/** Profile created by default ('dsh --profile dlient-chat'). */
const DEFAULT_PROFILE_NAME = "dlient-chat";
/** dsh version this build was verified against (mirrors the peer range). */
const VERIFIED_DSH_PREFIX = "0.1.1-rc.";
/** Minimum Node major the dsh CLI runs on. */
const MINIMUM_NODE_MAJOR = 20;
/** The Harness home environment variable, shared with the dsh CLI. */
const DSH_HOME_ENV = "DSH_HOME";

const USAGE = [
  "Usage: node install.js [options]",
  "",
  "Installs the 'dsh chat' surface: the @dlient/dsh-chat-ui plugin package plus the",
  "dlient-chat profile that composes it, into the DeepSeek Harness home.",
  "",
  "Options:",
  "  --dsh-home <path>   Harness home to install into (default: $DSH_HOME, else ~/.dsh)",
  "  --profile <name>    Profile name to create (default: " + DEFAULT_PROFILE_NAME + ")",
  "  --clean-legacy      Also remove leftover links from the earlier manual install",
  "                      method (only symlinks/junctions are ever removed)",
  "  -h, --help          Show this help",
  "",
  "Examples:",
  "  node install.js",
  "  node install.js --dsh-home D:/harness-home",
  "  dsh --profile " + DEFAULT_PROFILE_NAME + "     # then open http://127.0.0.1:3081",
  ""
].join("\n");

/** Thrown for a bad command line; reported with the usage text and exit code 2. */
class UsageError extends Error {}

/**
 * Parse this script's arguments.
 * @param argv - process.argv.slice(2).
 * @returns The resolved options.
 */
function parseArguments(argv) {
  const options = { help: false, cleanLegacy: false, dshHome: void 0, profile: DEFAULT_PROFILE_NAME };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--clean-legacy") options.cleanLegacy = true;
    else if (argument === "--dsh-home" || argument === "--profile") {
      const value = argv[index + 1];
      if (value === void 0 || value.startsWith("--")) throw new UsageError(argument + " needs a value");
      index += 1;
      if (argument === "--dsh-home") options.dshHome = value;
      else options.profile = value;
    } else throw new UsageError("unknown argument " + JSON.stringify(argument));
  }
  return options;
}

/**
 * Resolve the Harness home the same way the dsh CLI does (its resolveDshHome):
 * an explicit path, else a non-blank $DSH_HOME, else ~/.dsh. A blank override
 * counts as unset, and a leading ~ is expanded.
 * @param explicit - The --dsh-home value, if any.
 * @returns The absolute Harness home.
 */
function resolveDshHome(explicit) {
  const configured = explicit !== void 0 && explicit.trim() !== "" ? explicit.trim() : (process.env[DSH_HOME_ENV] ?? "").trim();
  if (configured === "") return join(homedir(), ".dsh");
  const normalized = configured.replace(/\\/g, "/");
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return resolve(join(homedir(), normalized.slice(2)));
  return resolve(normalized);
}

/**
 * Find an executable on PATH without going through a shell.
 * @param command - The command name, without extension.
 * @returns The resolved executable path (or undefined), plus the first
 * PowerShell-only shim seen (a .ps1 shim cannot stand in for the CLI here).
 */
function findExecutable(command) {
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat", ".ps1"] : [""];
  const directories = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
  const powershellOnly = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      if (extension === ".ps1") powershellOnly.push(candidate);
      else return { path: candidate, powershellOnly: powershellOnly[0] };
    }
  }
  return { path: void 0, powershellOnly: powershellOnly[0] };
}

/**
 * Whether one argument needs quoting for cmd.exe. spawn() with shell: true
 * joins arguments with spaces and does not quote them itself, so a path
 * containing spaces (or a cmd metacharacter) would otherwise be split apart.
 * @param argument - The raw argument.
 * @returns true when the argument must be wrapped in double quotes.
 */
function needsWindowsQuoting(argument) {
  for (const character of argument) if (character === '"' || " \t&|<>^()".includes(character)) return true;
  return false;
}

/**
 * Run one command, inheriting stdio, optionally through the platform shell.
 * @param command - The executable to run.
 * @param args - Its arguments.
 * @param environment - The child environment.
 * @param useShell - Whether to launch through the platform shell.
 * @returns The child's exit status, or undefined when it could not start.
 */
function run(command, args, environment, useShell) {
  const finalArgs = useShell ? args.map((argument) => (needsWindowsQuoting(argument) ? '"' + argument + '"' : argument)) : args;
  const result = spawnSync(command, finalArgs, {
    cwd: PACKAGE_ROOT,
    env: environment,
    shell: useShell,
    stdio: "inherit"
  });
  if (result.error !== void 0) {
    process.stderr.write("  could not run " + command + ": " + result.error.message + "\n");
    return void 0;
  }
  return result.status ?? 1;
}

/**
 * Report, and with --clean-legacy remove, a leftover link from the earlier
 * manual install method (a junction under <home>/profiles/node_modules, or this
 * checkout's own node_modules junction). Only symlinks/junctions are touched.
 * @param linkPath - The candidate link.
 * @param description - How to describe it in messages.
 * @param remove - Whether to remove it.
 * @returns true when a leftover link was found.
 */
function handleLegacyLink(linkPath, description, remove) {
  let stats;
  try {
    stats = lstatSync(linkPath);
  } catch {
    return false;
  }
  if (!stats.isSymbolicLink()) return false;
  if (!remove) {
    process.stdout.write("  note: " + description + " is a leftover link from the earlier manual install method\n");
    process.stdout.write("        " + linkPath + "\n");
    process.stdout.write("        This install does not use it; re-run with --clean-legacy to remove it.\n");
    return true;
  }
  try {
    rmSync(linkPath, { recursive: true, force: true });
    process.stdout.write("  removed legacy link " + linkPath + "\n");
  } catch (error) {
    process.stdout.write("  note: could not remove " + linkPath + " (" + (error instanceof Error ? error.message : String(error)) + ")\n");
  }
  return true;
}

/**
 * Install the profile files and the plugin package.
 * @param argv - process.argv.slice(2).
 * @returns The process exit code.
 */
export async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write("error: " + error.message + "\n\n" + USAGE + "\n");
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  const home = resolveDshHome(options.dshHome);
  const profileDir = join(home, "profiles", options.profile);
  process.stdout.write("Installing the 'dsh chat' surface into " + home + "\n");

  // 1. Preflight: everything below fails late and confusingly without these.
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(nodeMajor) && nodeMajor < MINIMUM_NODE_MAJOR) {
    process.stderr.write("error: Node " + process.versions.node + " is too old; the dsh CLI needs Node " + MINIMUM_NODE_MAJOR + " or newer\n");
    return 1;
  }
  const dsh = findExecutable("dsh");
  if (dsh.path === void 0) {
    if (dsh.powershellOnly !== void 0) {
      process.stderr.write("error: only a PowerShell shim for dsh was found (" + dsh.powershellOnly + "),\n");
      process.stderr.write("       which this script cannot launch. Run install.ps1 instead, or put a dsh .cmd shim on PATH.\n");
    } else {
      process.stderr.write("error: the dsh CLI is not on PATH — install it first:  npm i -g @deepseek-ai/dsh\n");
    }
    return 1;
  }
  const pnpm = findExecutable("pnpm");
  if (pnpm.path === void 0) {
    process.stderr.write("error: pnpm is not on PATH — install it first:  npm i -g pnpm\n");
    process.stderr.write("       (dsh plugin forwards to pnpm to install the package)\n");
    return 1;
  }

  // 2. Profile composition files. These must be in place before the plugin is
  //    added: dsh plugin would otherwise initialize a template profile whose
  //    bundle list is dsh-base alone, with no browser surface.
  if (!existsSync(PROFILE_SOURCE_DIR)) {
    process.stderr.write("error: " + PROFILE_SOURCE_DIR + " is missing — this package was not distributed whole\n");
    return 1;
  }
  mkdirSync(profileDir, { recursive: true });
  for (const file of PROFILE_FILES) {
    const source = join(PROFILE_SOURCE_DIR, file);
    if (!existsSync(source)) {
      process.stderr.write("error: " + source + " is missing — this package was not distributed whole\n");
      return 1;
    }
    copyFileSync(source, join(profileDir, file));
    process.stdout.write("  copied profile/" + file + " -> " + profileDir + "\n");
  }

  // 3. Install the package through the official profile-plugin manager. The
  //    absolute file: spec passes through untouched; pnpm hard-links the
  //    package into the profile's node_modules and installs its dependencies.
  const packageName = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).name;
  const pluginSpec = "file:" + PACKAGE_ROOT.split(sep).join("/");

  // On Windows, 'dsh plugin' forwards its arguments to pnpm through cmd.exe
  // without quoting them, so a file: spec whose path contains a space reaches
  // pnpm truncated ("could not install from ... as it does not exist"). pnpm
  // itself handles the spec fine when it is quoted, so the profile files are
  // copied first and then this exact command is offered as the way to finish.
  if (process.platform === "win32" && PACKAGE_ROOT.includes(" ")) {
    process.stderr.write("\nerror: this checkout lives under a path containing a space:\n");
    process.stderr.write("       " + PACKAGE_ROOT + "\n");
    process.stderr.write("       'dsh plugin' does not quote the file: spec when it forwards it to pnpm,\n");
    process.stderr.write("       so pnpm would see a truncated path. Either move the checkout to a path\n");
    process.stderr.write("       without spaces and re-run this script, or finish the last step by hand\n");
    process.stderr.write("       (the profile files above are already in place):\n");
    process.stderr.write("         cd /d \"" + profileDir + "\"\n");
    process.stderr.write("         pnpm add \"" + pluginSpec + "\"\n");
    return 1;
  }

  process.stdout.write("Adding the plugin package: dsh plugin --profile " + options.profile + " add " + pluginSpec + "\n");
  // DSH_HOME is set explicitly: the child must install into the same home this
  // script just copied the profile files into.
  const exitCode = run(
    dsh.path,
    ["plugin", "--profile", options.profile, "add", pluginSpec],
    { ...process.env, [DSH_HOME_ENV]: home },
    process.platform === "win32"
  );
  if (exitCode !== 0) {
    process.stderr.write("\nerror: 'dsh plugin add' failed (exit code " + (exitCode === void 0 ? "unknown" : exitCode) + ").\n");
    process.stderr.write("       Check that pnpm can reach the npm registry (it fetches commander and\n");
    process.stderr.write("       @deepseek-ai/dsh-cmdline), then re-run this script.\n");
    return exitCode === void 0 ? 1 : exitCode;
  }

  // 4. Verify where the package landed, and flag leftovers from the earlier
  //    manual (junction-based) install method.
  const installedManifest = join(profileDir, "node_modules", ...packageName.split("/"), "package.json");
  if (existsSync(installedManifest)) process.stdout.write("  installed " + packageName + " -> " + dirname(installedManifest) + "\n");
  else process.stderr.write("  warning: " + packageName + " was not found under " + join(profileDir, "node_modules") + " — check the pnpm output above\n");
  handleLegacyLink(join(home, "profiles", "node_modules", ...packageName.split("/")), "a shared-fallback link for this package", options.cleanLegacy);
  handleLegacyLink(join(PACKAGE_ROOT, "node_modules"), "this checkout's node_modules", options.cleanLegacy);

  // 5. Report. The version note is advisory: the surface is pinned to one
  //    prebuilt frontend (its CSS module hashes), so a different dsh may boot
  //    while the UI customisations silently stop applying.
  const versionProbe = spawnSync(dsh.path, ["--version"], { encoding: "utf8", env: process.env, shell: process.platform === "win32" });
  const dshVersion = (versionProbe.stdout ?? "").trim();
  process.stdout.write("\nInstalled" + (dshVersion === "" ? "" : " (dsh " + dshVersion + ")") + ". Launch it with:\n");
  process.stdout.write("  dsh --profile " + options.profile + "                    # serves http://127.0.0.1:3081\n");
  process.stdout.write("  dsh --profile " + options.profile + " --port 3111        # another port\n");
  process.stdout.write("  dsh --profile " + options.profile + " --workspace <path> # register that directory as the workspace\n");
  if (dshVersion !== "" && !dshVersion.startsWith(VERIFIED_DSH_PREFIX)) {
    process.stdout.write("\n  note: this build was verified against dsh " + VERIFIED_DSH_PREFIX + "x; " + dshVersion + " may boot, but the\n");
    process.stdout.write("        frontend-pinned UI customisations (hidden sidebar/top strip) can stop applying.\n");
  }
  process.stdout.write("\nVerify the client bundle is served:\n");
  process.stdout.write("  curl http://127.0.0.1:3081/plugins/" + packageName + "/client.js   # -> 200\n");
  return 0;
}

/** Whether this module is the process entry point ('node install.js'). */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (entry === void 0) return false;
  try {
    return realpathSync(resolve(entry)) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Failures outside main's own checks (an unwritable home, a malformed
    // profile manifest, ...) still deserve one clean line, not a stack trace.
    process.stderr.write("error: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
