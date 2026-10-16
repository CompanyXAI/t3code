// @effect-diagnostics globalTimers:off -- plain Node timer in non-Effect worker/connection code.
// @effect-diagnostics nodeBuiltinImport:off -- the index is built in a worker thread over node:sqlite.
/**
 * Index of every composer in the Cursor IDE global state DB, for the import scan.
 *
 * Evidence (SCH99, read-only, immutable=1):
 * - `cursorDiskKV` `composerData:<id>` holds 5258 composers. Only 134 appear in a
 *   workspace's `ItemTable['composer.composerData'].allComposers` list; that list is the
 *   only place `isArchived` is stored.
 * - `composerData.workspaceIdentifier.id` equals a `workspaceStorage/<id>` folder name
 *   (4356 of 5258 match exactly); that folder's `workspace.json` names the project folder.
 *   This is the only accepted composer-to-folder link; anything else stays unbound.
 * - `subagentComposerIds` on a parent lists its subagent composers; `subagentInfo` marks
 *   a subagent; `isDraft` marks drafts (their unsent text is `composerData.text`).
 *
 * Reading every composer value takes ~35 s on a 15.7 GB DB, so it runs in a worker
 * thread (never on the server's event loop) and is cached by DB file mtime.
 *
 * @module project/CursorIdeIndex
 */
import * as NodeFS from "node:fs";
import * as NodeWorkerThreads from "node:worker_threads";

export interface CursorIdeComposerEntry {
  readonly composerId: string;
  readonly name: string | null;
  readonly workspaceId: string | null;
  readonly createdAtMs: number | null;
  readonly lastUpdatedAtMs: number | null;
  readonly isDraft: boolean;
  readonly isSubagent: boolean;
  readonly draftText: string | null;
  readonly subagentComposerIds: ReadonlyArray<string>;
}

export interface CursorIdeIndex {
  readonly composers: ReadonlyMap<string, CursorIdeComposerEntry>;
  /** composerId -> isArchived, from workspace allComposers lists. Absent = in no list. */
  readonly workspaceListState: ReadonlyMap<string, { workspaceId: string; archived: boolean }>;
  /** subagent composerId -> parent composerId (from the parent's subagentComposerIds). */
  readonly parentOf: ReadonlyMap<string, string>;
  /** composerId -> folder proven only by its file paths (see cursorIdePathEvidenceFolder). */
  readonly pathFolderOf: ReadonlyMap<string, string>;
}

/**
 * Folder proven by a composer's own file paths, for a composer with no workspace id.
 * Paths come from `context`, `originalFileStates`, `trackedGitRepos`, `newlyCreatedFiles`,
 * `codeBlockData` and each bubble's relevantFiles / attached folders / tool params+results /
 * workspaceUris. Accepted only when every path under a known folder lies under the same
 * one (deepest match); paths under several folders, or only outside them, prove nothing.
 * Runs inside the worker (serialized with toString), so it must stay self-contained.
 */
export function cursorIdePathEvidenceFolder(
  composer: Record<string, unknown>,
  readBubble: (bubbleId: string) => string | null,
  folders: ReadonlyArray<{ readonly key: string; readonly folder: string }>,
  foldCase: boolean,
): string | null {
  const uriRe = /(?:file:\/\/\/|[a-zA-Z]:[\\/]|\/(?:home|Users)\/)[^"'\s<>]{3,}/g;
  const norm = (raw: string) => {
    let s = raw;
    if (s.startsWith("file:///")) {
      try {
        s = decodeURIComponent(s.slice(8));
        if (!/^[a-zA-Z]:/.test(s)) s = `/${s}`;
      } catch {
        return null;
      }
    }
    // JSON-escaped Windows paths carry doubled backslashes; collapse any run of separators.
    s = s.replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return foldCase ? s.toLowerCase() : s;
  };
  const paths = new Set<string>();
  const collect = (value: unknown) => {
    if (value === undefined || value === null) return;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const match of text.match(uriRe) ?? []) {
      const p = norm(match);
      if (p !== null) paths.add(p);
    }
  };
  const objectKeys = (value: unknown) =>
    value !== null && typeof value === "object" ? Object.keys(value).join(" ") : null;
  collect(composer.context);
  collect(objectKeys(composer.originalFileStates));
  collect(composer.trackedGitRepos);
  collect(composer.newlyCreatedFiles);
  collect(objectKeys(composer.codeBlockData));
  const headers = Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly
    : [];
  for (const header of headers.slice(0, 400)) {
    const bubbleId = (header as { bubbleId?: unknown } | null)?.bubbleId;
    if (typeof bubbleId !== "string") continue;
    const raw = readBubble(bubbleId);
    if (raw === null) continue;
    let bubble: Record<string, unknown>;
    try {
      bubble = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    collect(bubble.relevantFiles);
    collect(bubble.attachedFolders);
    collect(bubble.attachedFoldersNew);
    collect(bubble.attachedFolderUris);
    collect(bubble.workspaceUris);
    const tool = bubble.toolFormerData as Record<string, unknown> | undefined;
    if (tool) {
      collect(tool.params ?? tool.rawArgs);
      collect(tool.result);
    }
  }
  const matched = new Set<string>();
  for (const p of paths) {
    let best: { key: string; folder: string } | null = null;
    for (const f of folders) {
      if (
        (p === f.key || p.startsWith(`${f.key}/`)) &&
        (best === null || f.key.length > best.key.length)
      ) {
        best = f;
      }
    }
    if (best !== null) matched.add(best.folder);
  }
  return matched.size === 1 ? [...matched][0]! : null;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL, fileURLToPath } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const open = (p) => new DatabaseSync(pathToFileURL(p).href + "?immutable=1", { readOnly: true });
const out = { composers: [], lists: [], pathFolders: [] };
const db = open(workerData.globalDb);
try {
  const rows = db.prepare(
    "SELECT substr(key, 14) AS id, json_extract(value, '$.name') AS name," +
    " json_extract(value, '$.workspaceIdentifier.id') AS wid," +
    " json_extract(value, '$.createdAt') AS createdAt, json_extract(value, '$.lastUpdatedAt') AS updatedAt," +
    " json_extract(value, '$.isDraft') AS isDraft, json_extract(value, '$.subagentInfo') IS NOT NULL AS isSub," +
    " CASE WHEN json_extract(value, '$.isDraft') THEN json_extract(value, '$.text') END AS draftText," +
    " json_extract(value, '$.subagentComposerIds') AS subs" +
    " FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'"
  ).all();
  for (const r of rows) out.composers.push(r);
} finally { db.close(); }
let dirs = [];
try { dirs = fs.readdirSync(workerData.workspaceStorage); } catch {}
// Transpilers may wrap inner functions in __name(...) (keepNames); make it a no-op here.
var __name = (f) => f;
const pathEvidenceFolder = ${cursorIdePathEvidenceFolder.toString()};
{
  const foldCase = process.platform === "win32";
  const folders = [];
  for (const d of dirs) {
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(workerData.workspaceStorage, d, "workspace.json"), "utf8"));
      if (typeof ws.folder !== "string" || !ws.folder.startsWith("file:")) continue;
      const folder = fileURLToPath(ws.folder);
      let key = folder.replace(/\\\\/g, "/").replace(/\\/+$/, "");
      if (foldCase) key = key.toLowerCase();
      folders.push({ key, folder });
    } catch {}
  }
  // Listing never reads bubbles. Path evidence is a separate opt-in (~100s cold).
  if (workerData.readPathEvidence) {
  const ev = open(workerData.globalDb);
  try {
    const get = ev.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    const text = (v) => (typeof v === "string" ? v : Buffer.from(v).toString("utf8"));
    for (const r of out.composers) {
      if (r.wid || r.isSub) continue;
      const row = get.get("composerData:" + r.id);
      if (!row) continue;
      let composer;
      try { composer = JSON.parse(text(row.value)); } catch { continue; }
      const folder = pathEvidenceFolder(composer, (b) => {
        const bubble = get.get("bubbleId:" + r.id + ":" + b);
        return bubble ? text(bubble.value) : null;
      }, folders, foldCase);
      if (folder) out.pathFolders.push([r.id, folder]);
    }
  } finally { ev.close(); }
  }
}
for (const d of dirs) {
  const p = path.join(workerData.workspaceStorage, d, "state.vscdb");
  if (!fs.existsSync(p)) continue;
  try {
    const w = open(p);
    try {
      const row = w.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
      if (row) {
        const parsed = JSON.parse(typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8"));
        for (const c of parsed.allComposers || []) {
          if (typeof c.composerId === "string") out.lists.push([c.composerId, d, c.isArchived === true]);
        }
      }
    } finally { w.close(); }
  } catch {}
}
parentPort.postMessage(out);
`;

interface WorkerRow {
  id: string;
  name: unknown;
  wid: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  isDraft: unknown;
  isSub: unknown;
  draftText: unknown;
  subs: unknown;
}

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

export function buildCursorIdeIndex(
  rows: ReadonlyArray<WorkerRow>,
  lists: ReadonlyArray<readonly [string, string, boolean]>,
  pathFolders: ReadonlyArray<readonly [string, string]> = [],
): CursorIdeIndex {
  const composers = new Map<string, CursorIdeComposerEntry>();
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    let subs: Array<string> = [];
    if (typeof row.subs === "string") {
      try {
        const parsed: unknown = JSON.parse(row.subs);
        if (Array.isArray(parsed))
          subs = parsed.filter((id): id is string => typeof id === "string");
      } catch {
        subs = [];
      }
    }
    composers.set(row.id, {
      composerId: row.id,
      name: str(row.name),
      workspaceId: str(row.wid),
      createdAtMs: num(row.createdAt),
      lastUpdatedAtMs: num(row.updatedAt),
      isDraft: row.isDraft === 1 || row.isDraft === true,
      isSubagent: row.isSub === 1 || row.isSub === true,
      draftText: str(row.draftText),
      subagentComposerIds: subs,
    });
  }
  for (const entry of composers.values()) {
    for (const child of entry.subagentComposerIds) {
      // Only a unique parent is accepted.
      if (parentOf.has(child) && parentOf.get(child) !== entry.composerId) parentOf.set(child, "");
      else parentOf.set(child, entry.composerId);
    }
  }
  for (const [child, parent] of parentOf) if (parent === "") parentOf.delete(child);
  const workspaceListState = new Map<string, { workspaceId: string; archived: boolean }>();
  for (const [composerId, workspaceId, archived] of lists) {
    workspaceListState.set(composerId, { workspaceId, archived });
  }
  return { composers, workspaceListState, parentOf, pathFolderOf: new Map(pathFolders) };
}

let cache: {
  key: string;
  readPathEvidence: boolean;
  builtAt: number;
  index: Promise<CursorIdeIndex>;
} | null = null;

function cacheKey(globalDb: string, readPathEvidence: boolean): string | null {
  try {
    const main = NodeFS.statSync(globalDb).mtimeMs;
    let wal = 0;
    try {
      wal = NodeFS.statSync(`${globalDb}-wal`).mtimeMs;
    } catch {
      wal = 0;
    }
    return `${globalDb}\0${main}\0${wal}\0${readPathEvidence ? "1" : "0"}`;
  } catch {
    return null;
  }
}

/**
 * The composer index, built off the event loop; null when the DB is absent or the build fails or times out.
 * Listing passes `readPathEvidence: false` so the worker never opens bubble rows.
 * `reuse` keeps serving an index built that recently even when the db has
 * changed since: a running IDE touches the db every few seconds.
 */
export async function loadCursorIdeIndex(
  globalDb: string,
  workspaceStorage: string,
  timeoutMs = 300_000,
  readPathEvidence = false,
  /** Serve an index built within maxAgeMs of now, even if the db changed since. */
  reuse: { readonly now: number; readonly maxAgeMs: number } = { now: 0, maxAgeMs: 0 },
): Promise<CursorIdeIndex | null> {
  const key = cacheKey(globalDb, readPathEvidence);
  if (key === null) return null;
  const fresh =
    cache !== null &&
    (cache.key === key ||
      (cache.readPathEvidence === readPathEvidence &&
        cache.key.startsWith(`${globalDb}\0`) &&
        reuse.now - cache.builtAt < reuse.maxAgeMs));
  if (!fresh) {
    const index = new Promise<CursorIdeIndex>((resolve, reject) => {
      const worker = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { globalDb, workspaceStorage, readPathEvidence },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Cursor IDE index timed out"));
      }, timeoutMs);
      worker.once(
        "message",
        (message: {
          composers: WorkerRow[];
          lists: [string, string, boolean][];
          pathFolders: [string, string][];
        }) => {
          clearTimeout(timer);
          void worker.terminate();
          resolve(buildCursorIdeIndex(message.composers, message.lists, message.pathFolders));
        },
      );
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    cache = { key, readPathEvidence, builtAt: reuse.now, index };
    index.catch(() => {
      if (cache?.index === index) cache = null;
    });
  }
  return cache!.index.catch(() => null);
}

/** Virtual transcript path for a composer that only exists in the IDE DB. */
export const CURSOR_IDE_COMPOSER_MARK = "#cursor-composer=";
export const cursorIdeComposerPath = (globalDb: string, composerId: string) =>
  `${globalDb}${CURSOR_IDE_COMPOSER_MARK}${composerId}`;
export function parseCursorIdeComposerPath(
  filePath: string,
): { readonly globalDb: string; readonly composerId: string } | null {
  const at = filePath.lastIndexOf(CURSOR_IDE_COMPOSER_MARK);
  if (at < 0) return null;
  return {
    globalDb: filePath.slice(0, at),
    composerId: filePath.slice(at + CURSOR_IDE_COMPOSER_MARK.length),
  };
}

/** The top composer of a subagent chain (parentOf followed to the end); null for a non-subagent. */
export function cursorIdeRootComposer(index: CursorIdeIndex, composerId: string): string | null {
  const seen = new Set<string>([composerId]);
  let current = index.parentOf.get(composerId);
  if (current === undefined) return null;
  for (;;) {
    const next = index.parentOf.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(current);
    current = next;
  }
}

/** Labels shown per chat in the import list; nothing is hidden, only labeled. */
export function cursorIdeComposerLabels(
  index: CursorIdeIndex,
  composerId: string,
): ReadonlyArray<string> {
  const labels: Array<string> = ["IDE"];
  const entry = index.composers.get(composerId);
  const listed = index.workspaceListState.get(composerId);
  if (listed === undefined) labels.push("not in any workspace list");
  else labels.push(listed.archived ? "archived" : "active");
  if (entry?.isDraft) labels.push("draft");
  if (index.pathFolderOf.has(composerId)) labels.push("from file paths");
  if (entry?.isSubagent || index.parentOf.has(composerId)) labels.push("subagent");
  return labels;
}
