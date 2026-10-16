// @effect-diagnostics nodeBuiltinImport:off -- pure path helpers shared by the driver, usage and machine controls.
/**
 * Where an instance's Cursor CLI keeps its login, following T3's `homePath`
 * pattern for Claude (`CLAUDE_CONFIG_DIR`) and Codex (`CODEX_HOME`).
 *
 * The Cursor CLI reads its login from the user's config folder (`APPDATA` on
 * Windows, `XDG_CONFIG_HOME` elsewhere). An empty `homePath` is the standard
 * login of the machine; a set `homePath` points that folder at the
 * instance's own directory, so several accounts run side by side. Cursor has
 * no official profile feature, so a custom `homePath` is unofficial.
 *
 * Every Cursor code path (CLI login, limits, usage, worker, autostart) asks
 * this module instead of building paths itself.
 *
 * @module provider-cursor/server/CursorHome
 */
import * as NodePath from "node:path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

export type CursorPlatform = "win32" | "darwin" | "linux" | (string & {});

export interface CursorHomeConfig {
  readonly homePath?: string | undefined;
}

export interface CursorHomeContext {
  readonly platform: CursorPlatform;
  readonly environment: NodeJS.ProcessEnv;
  /** The current user's home directory. */
  readonly home: string;
}

/** Path rules of the platform the CLI runs on. */
const pathFor = (platform: CursorPlatform) =>
  platform === "win32" ? NodePath.win32 : NodePath.posix;

const normalize = (value: string, platform: CursorPlatform) => {
  const resolved = pathFor(platform)
    .resolve(value)
    .replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** The machine's standard Cursor config folder (the default login). */
export function standardCursorHomePath(context: CursorHomeContext): string {
  const { platform, environment, home } = context;
  const path = pathFor(platform);
  if (platform === "win32") {
    return path.resolve(environment.APPDATA?.trim() || path.join(home, "AppData", "Roaming"));
  }
  return path.resolve(environment.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"));
}

/** True when the instance has its own `homePath`. */
export function hasCustomCursorHome(config: CursorHomeConfig): boolean {
  return (config.homePath?.trim() ?? "").length > 0;
}

/** The config folder this instance's CLI uses: its `homePath`, else the standard login. */
export function resolveCursorHomePath(
  config: CursorHomeConfig,
  context: CursorHomeContext,
): string {
  const homePath = config.homePath?.trim() ?? "";
  if (homePath.length === 0) return standardCursorHomePath(context);
  return pathFor(context.platform).resolve(expandHomePath(homePath, context.home));
}

/**
 * Environment for this instance's CLI. Unchanged for the standard login;
 * otherwise the config folder points at `homePath` (file credential store
 * outside Windows, so the login stays in that folder).
 */
export function makeCursorEnvironment(
  config: CursorHomeConfig,
  context: CursorHomeContext,
): NodeJS.ProcessEnv {
  if (!hasCustomCursorHome(config)) return context.environment;
  const dir = resolveCursorHomePath(config, context);
  if (context.platform === "win32") return { ...context.environment, APPDATA: dir };
  return { ...context.environment, XDG_CONFIG_HOME: dir, AGENT_CLI_CREDENTIAL_STORE: "file" };
}

/**
 * True when the instance uses the machine's standard login. That login is
 * shared with the Cursor desktop app and hand-made workers (on SCH99 the
 * protected `CursorAgentWorkerTerminal` task), so T3 never signs it out or
 * runs a worker or logon entry from it.
 */
export function isStandardCursorHome(
  config: CursorHomeConfig,
  context: CursorHomeContext,
): boolean {
  return (
    normalize(resolveCursorHomePath(config, context), context.platform) ===
    normalize(standardCursorHomePath(context), context.platform)
  );
}

/** The CLI login file inside a resolved config folder (`cursor` outside Windows). */
export const cursorLoginFile = (homeDir: string, platform: CursorPlatform) =>
  pathFor(platform).join(homeDir, platform === "win32" ? "Cursor" : "cursor", "auth.json");
