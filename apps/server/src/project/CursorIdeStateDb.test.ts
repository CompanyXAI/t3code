// @effect-diagnostics nodeBuiltinImport:off - builds a synthetic state.vscdb on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";

import {
  closeCursorIdeStateDbs,
  cursorIdeStateDbOpenCount,
  decodeCursorIdeComposer,
  readCursorIdeComposer,
} from "./CursorIdeStateDb.ts";

const composer = JSON.stringify({
  name: "Fix build",
  createdAt: 1000,
  // Header order, not bubble timestamps, decides message order.
  fullConversationHeadersOnly: [
    { bubbleId: "u1", type: 1 },
    { bubbleId: "a1", type: 2 },
    { bubbleId: "a2", type: 2 },
    { bubbleId: "gone", type: 2 },
    { bubbleId: "a3", type: 2 },
  ],
});
const bubbles: Record<string, unknown> = {
  u1: { type: 1, text: "please fix", createdAt: "1970-01-01T00:00:09.000Z" },
  a1: { type: 2, text: "", thinking: { text: "look at logs", signature: "x" }, startedAtMs: 5 },
  a2: {
    type: 2,
    text: "",
    startedAtMs: 4,
    toolFormerData: {
      toolCallId: "t1",
      name: "run_terminal_command_v2",
      params: JSON.stringify({ command: "npm test", cwd: "/w" }),
      result: JSON.stringify({ output: "ok", exitCode: 1 }),
    },
  },
  a3: {
    type: 2,
    text: "done",
    startedAtMs: 3,
    toolFormerData: {
      toolCallId: "t2",
      name: "read_file_v2",
      params: JSON.stringify({ targetFile: "a.ts" }),
      result: JSON.stringify({ totalLinesInFile: 3 }),
    },
  },
};

describe("decodeCursorIdeComposer", () => {
  it("maps bubbles in header order to text, reasoning, command and tool entries", () => {
    const decoded = decodeCursorIdeComposer(composer, (id) =>
      bubbles[id] === undefined ? null : JSON.stringify(bubbles[id]),
    );
    expect(decoded?.title).toBe("Fix build");
    expect(decoded?.messages).toEqual([
      { kind: "text", role: "user", text: "please fix", atMs: 9000 },
      { kind: "reasoning", text: "look at logs", atMs: 5 },
      {
        kind: "command",
        command: "npm test",
        output: "ok",
        exitCode: 1,
        toolCallId: "t1",
        atMs: 4,
      },
      {
        kind: "tool",
        toolName: "read_file_v2",
        toolCallId: "t2",
        input: { targetFile: "a.ts" },
        output: { totalLinesInFile: 3 },
        atMs: 3,
      },
      { kind: "text", role: "assistant", text: "done", atMs: 3 },
    ]);
  });

  it("returns null without a conversation header list", () => {
    expect(decodeCursorIdeComposer("{}", () => null)).toBeNull();
  });
});

describe("readCursorIdeComposer", () => {
  it("reads one composer by key from cursorDiskKV", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-ide-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    put.run("composerData:c1", composer);
    for (const [id, bubble] of Object.entries(bubbles))
      put.run(`bubbleId:c1:${id}`, JSON.stringify(bubble));
    db.close();
    try {
      expect(readCursorIdeComposer(dbPath, "c1")?.messages).toHaveLength(5);
      expect(readCursorIdeComposer(dbPath, "missing")).toBeNull();
      expect(readCursorIdeComposer(NodePath.join(dir, "none.vscdb"), "c1")).toBeNull();
      // Regression: one open per DB, not per composer (per-open WAL replay blocked the server).
      const before = cursorIdeStateDbOpenCount();
      for (let i = 0; i < 20; i += 1) readCursorIdeComposer(dbPath, "c1");
      expect(cursorIdeStateDbOpenCount() - before).toBe(0);
      closeCursorIdeStateDbs();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
