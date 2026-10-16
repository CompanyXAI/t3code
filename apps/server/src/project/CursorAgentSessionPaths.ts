// @effect-diagnostics nodeBuiltinImport:off - resolves the Cursor IDE user-data folder.
/**
 * Cursor workspace cwd for agent transcripts.
 *
 * Evidence (cursor-agent 2026.10.01 + Cursor IDE workbench, SCH99):
 * - ~/.cursor/projects/<name> uses a lossy slug (`[^a-zA-Z0-9]` -> "-") of the
 *   first workspace folder, or the window's workspace id when no folder is open
 *   (empty windows get `(Date.now() + random(0..1000)).toString()` -> numeric
 *   folders, typically canvases-only). The name cannot be decoded reliably.
 * - ~/.cursor/chats/<md5(resolved cwd)>/<agentId>/meta.json records `cwd`
 *   directly.
 * - The slug function itself is `e.replace(/[^a-zA-Z0-9]/g,"-").replace(/-+/g,"-")
 *   .replace(/^-+|-+$/g,"")` (workbench "workspace-paths.ts"). It is applied
 *   FORWARD to every folder Cursor itself recorded (chats meta cwd, SDK agent
 *   workspace_ref, IDE workspaceStorage/<id>/workspace.json `folder`); a
 *   transcript gets a cwd only when exactly one recorded folder produces its
 *   project folder name. No match or several matches -> orphan.
 *
 * @module project/CursorAgentSessionPaths
 */
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

/** Parse a chats meta.json body; returns cwd only when present and non-empty. */
export function parseCursorChatMetaCwd(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return null;
    const cwd = (parsed as { cwd?: unknown }).cwd;
    return typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  } catch {
    return null;
  }
}

/** Cursor's ~/.cursor/projects/<slug> function (workbench workspace-paths.ts `t8i`). */
export function cursorProjectSlug(folder: string): string {
  return folder
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Folder path from a workspaceStorage workspace.json; only local `file:` folders. */
export function parseCursorWorkspaceFolder(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return null;
    const folder = (parsed as { folder?: unknown }).folder;
    if (typeof folder !== "string" || !folder.startsWith("file://")) return null;
    // Platform-independent decode: file:///c%3A/x -> c:\x, file:///home/x -> /home/x.
    const decoded = decodeURIComponent(new URL(folder).pathname);
    const drive = /^\/([a-zA-Z]:)(\/.*)?$/.exec(decoded);
    return drive ? `${drive[1]}${(drive[2] ?? "/").replace(/\//g, "\\")}` : decoded;
  } catch {
    return null;
  }
}

/** Cursor IDE workspaceStorage (VS Code user-data layout) for this OS user. */
export function cursorIdeWorkspaceStorageDir(
  pathApi: Path.Path,
  platform: NodeJS.Platform = HostProcess.Platform.defaultValue(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = NodeOS.homedir(),
): string {
  const userData =
    platform === "win32"
      ? pathApi.join(env.APPDATA?.trim() || pathApi.join(home, "AppData", "Roaming"), "Cursor")
      : platform === "darwin"
        ? pathApi.join(home, "Library", "Application Support", "Cursor")
        : pathApi.join(env.XDG_CONFIG_HOME?.trim() || pathApi.join(home, ".config"), "Cursor");
  return pathApi.join(userData, "User", "workspaceStorage");
}

/** Cursor IDE global state DB (composer + bubble history). */
export function cursorIdeGlobalStateDb(pathApi: Path.Path, workspaceStorageDir: string): string {
  return pathApi.join(pathApi.dirname(workspaceStorageDir), "globalStorage", "state.vscdb");
}

/**
 * slug -> folder when exactly one recorded folder yields that slug; slugs hit by
 * several distinct folders map to null (ambiguous -> orphan).
 */
export function buildCursorSlugIndex(
  folders: Iterable<string>,
): ReadonlyMap<string, string | null> {
  const index = new Map<string, string | null>();
  for (const folder of folders) {
    const slug = cursorProjectSlug(folder);
    if (slug.length === 0) continue;
    const existing = index.get(slug);
    if (existing === undefined) index.set(slug, folder);
    else if (existing !== null && existing !== folder) index.set(slug, null);
  }
  return index;
}

export interface CursorChatEntry {
  /** null when meta.json records no cwd (listed as an orphan, never guessed). */
  readonly cwd: string | null;
  readonly chatDir: string;
}

/**
 * Build agentId -> cwd from ~/.cursor/chats/<hash>/<agentId>/meta.json.
 */
export function readCursorChatCwdIndex(
  chatsDir: string,
  pathApi: Path.Path,
  readDirectory: (directory: string) => Effect.Effect<ReadonlyArray<string>>,
  readFile: (filePath: string) => Effect.Effect<Option.Option<string>>,
): Effect.Effect<ReadonlyMap<string, CursorChatEntry>> {
  return Effect.gen(function* () {
    const index = new Map<string, CursorChatEntry>();
    for (const hashDir of yield* readDirectory(chatsDir)) {
      for (const agentId of yield* readDirectory(pathApi.join(chatsDir, hashDir))) {
        const body = yield* readFile(pathApi.join(chatsDir, hashDir, agentId, "meta.json"));
        if (Option.isNone(body)) continue;
        const cwd = parseCursorChatMetaCwd(body.value);
        index.set(agentId, { cwd, chatDir: pathApi.join(chatsDir, hashDir, agentId) });
      }
    }
    return index;
  });
}
