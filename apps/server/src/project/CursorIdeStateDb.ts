// @effect-diagnostics globalTimers:off -- plain Node timer in non-Effect worker/connection code.
// @effect-diagnostics nodeBuiltinImport:off - opens Cursor IDE's global state.vscdb read-only.
/**
 * Cursor IDE chat history from `<user-data>/User/globalStorage/state.vscdb`.
 *
 * Evidence (Cursor IDE, SCH99): table `cursorDiskKV(key TEXT UNIQUE, value BLOB)`.
 * - `composerData:<composerId>` JSON: `name`, `createdAt`, and
 *   `fullConversationHeadersOnly: [{ bubbleId, type }]` in conversation order.
 * - `bubbleId:<composerId>:<bubbleId>` JSON: `type` (1 user, 2 assistant), `text`,
 *   `thinking.text`, `toolFormerData { toolCallId, name, params, rawArgs, result }`
 *   (params/rawArgs/result are JSON strings), `startedAtMs`, `createdAt`.
 * The composer id equals the agent-transcripts JSONL id.
 *
 * The database is ~15 GB and live, so it is never copied or written. It is
 * opened read-only with SQLite `mode=ro` (WAL-aware, so chats Cursor has not
 * checkpointed yet are included; WAL readers never block Cursor's writer) and
 * only read through exact primary-key lookups. Verified on SCH99 with Cursor
 * running: open+query 15 ms; db, -wal and -shm size and mtime unchanged. If
 * that open fails, `immutable=1` (no locks, ignores the WAL, may miss the
 * newest changes) is used instead. A composer missing here falls back to the
 * JSONL transcript.
 *
 * @module project/CursorIdeStateDb
 */
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type { CursorStoreDbMessage } from "./CursorStoreDb.ts";

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asString = (value: unknown) => (typeof value === "string" ? value : null);
const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Terminal tool calls render as command items; everything else as dynamic tools. */
const TERMINAL_TOOLS = new Set([
  "run_terminal_command",
  "run_terminal_command_v2",
  "run_terminal_cmd",
]);

export interface CursorIdeComposer {
  readonly title: string | null;
  readonly createdAtMs: number | null;
  readonly messages: ReadonlyArray<CursorStoreDbMessage>;
}

/** Decode one composer given its composerData JSON and a bubble lookup. */
export function decodeCursorIdeComposer(
  composerJson: string,
  readBubble: (bubbleId: string) => string | null,
): CursorIdeComposer | null {
  const composer = asRecord(parseJson(composerJson));
  const headers = composer.fullConversationHeadersOnly;
  if (!Array.isArray(headers)) return null;
  const messages: Array<CursorStoreDbMessage> = [];
  for (const header of headers) {
    const bubbleId = asString(asRecord(header).bubbleId);
    if (bubbleId === null) continue;
    const raw = readBubble(bubbleId);
    if (raw === null) continue;
    const bubble = asRecord(parseJson(raw));
    const createdAt = asString(bubble.createdAt);
    const parsedAt = createdAt === null ? Number.NaN : Date.parse(createdAt);
    const atMs = asNumber(bubble.startedAtMs) ?? (Number.isFinite(parsedAt) ? parsedAt : null);
    const text = asString(bubble.text) ?? "";
    if (bubble.type === 1) {
      if (text.trim().length > 0) messages.push({ kind: "text", role: "user", text, atMs });
      continue;
    }
    if (bubble.type !== 2) continue;
    const thinking = asString(asRecord(bubble.thinking).text);
    if (thinking !== null && thinking.trim().length > 0) {
      messages.push({ kind: "reasoning", text: thinking, atMs });
    }
    const tool = asRecord(bubble.toolFormerData);
    const toolName = asString(tool.name);
    if (toolName !== null) {
      const params = parseJson(tool.params);
      const input = params ?? parseJson(tool.rawArgs);
      const output = parseJson(tool.result);
      const toolCallId = asString(tool.toolCallId);
      if (TERMINAL_TOOLS.has(toolName)) {
        const result = asRecord(output);
        messages.push({
          kind: "command",
          command: asString(asRecord(input).command) ?? "",
          output: asString(result.output),
          exitCode: asNumber(result.exitCode),
          toolCallId,
          atMs,
        });
      } else {
        messages.push({ kind: "tool", toolName, toolCallId, input, output, atMs });
      }
    }
    if (text.trim().length > 0) messages.push({ kind: "text", role: "assistant", text, atMs });
  }
  return {
    title: asString(composer.name),
    createdAtMs: asNumber(composer.createdAt),
    messages,
  };
}

/**
 * One shared read-only connection per DB path. Opening the IDE DB with
 * `mode=ro` replays its WAL index (~150 ms on a 15.7 GB DB with a 5 MB WAL), and
 * `DatabaseSync` blocks the event loop: opening per composer during an import of
 * ~1500 IDE chats stalled the server for minutes (splash hang on /api/auth/session).
 * The connection is reused and closed once idle so Cursor's newer writes are seen
 * on the next import.
 */
const IDLE_CLOSE_MS = 10_000;
const connections = new Map<
  string,
  { db: NodeSqlite.DatabaseSync; timer: ReturnType<typeof setTimeout> | null }
>();
let openCount = 0;

/** Number of DB opens so far; for tests. */
export function cursorIdeStateDbOpenCount(): number {
  return openCount;
}

function openIdeDb(dbPath: string): NodeSqlite.DatabaseSync {
  const href = NodeURL.pathToFileURL(dbPath).href;
  openCount += 1;
  try {
    const db = new NodeSqlite.DatabaseSync(`${href}?mode=ro`, { readOnly: true });
    db.prepare("SELECT 1 FROM cursorDiskKV LIMIT 1").get();
    return db;
  } catch {
    return new NodeSqlite.DatabaseSync(`${href}?immutable=1`, { readOnly: true });
  }
}

function sharedIdeDb(dbPath: string): NodeSqlite.DatabaseSync {
  let entry = connections.get(dbPath);
  if (entry === undefined) {
    entry = { db: openIdeDb(dbPath), timer: null };
    connections.set(dbPath, entry);
  }
  if (entry.timer !== null) clearTimeout(entry.timer);
  const current = entry;
  current.timer = setTimeout(() => {
    connections.delete(dbPath);
    current.db.close();
  }, IDLE_CLOSE_MS);
  current.timer.unref?.();
  return current.db;
}

/** Closes shared connections now (tests, shutdown). */
export function closeCursorIdeStateDbs(): void {
  for (const [dbPath, entry] of connections) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.db.close();
    connections.delete(dbPath);
  }
}

/** Read one composer by id; null when the DB or composer is absent. */
export function readCursorIdeComposer(
  dbPath: string,
  composerId: string,
): CursorIdeComposer | null {
  if (!NodeFS.existsSync(dbPath)) return null;
  const db = sharedIdeDb(dbPath);
  const get = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const read = (key: string): string | null => {
    const row = get.get(key) as { value?: unknown } | undefined;
    const value = row?.value;
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
    return null;
  };
  const composerJson = read(`composerData:${composerId}`);
  if (composerJson === null) return null;
  return decodeCursorIdeComposer(composerJson, (bubbleId) =>
    read(`bubbleId:${composerId}:${bubbleId}`),
  );
}
