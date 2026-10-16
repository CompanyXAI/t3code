// @effect-diagnostics nodeBuiltinImport:off - builds synthetic store.db files on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";

import {
  decodeConversationTree,
  decodeCursorChatStore,
  isT3CursorSdkAgent,
  readCursorSdkAgent,
} from "./CursorStoreDb.ts";

const varint = (value: number): Array<number> => {
  const out: Array<number> = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const len = (no: number, bytes: Uint8Array) =>
  Uint8Array.from([...varint((no << 3) | 2), ...varint(bytes.length), ...bytes]);
const num = (no: number, value: number) => Uint8Array.from([...varint(no << 3), ...varint(value)]);
const str = (no: number, text: string) => len(no, new TextEncoder().encode(text));
const cat = (...parts: Array<Uint8Array>) => Uint8Array.from(parts.flatMap((part) => [...part]));
const sha = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest();

/** Blobs come back in REVERSE creation order so row order cannot explain the result. */
function buildTree() {
  const blobs: Array<[string, Uint8Array]> = [];
  const put = (bytes: Uint8Array) => {
    blobs.unshift([sha(bytes).toString("hex"), bytes]);
    return sha(bytes);
  };
  const turn = (user: string, steps: Array<Uint8Array>) => {
    const userId = put(str(1, user));
    const stepIds = steps.map((step) => put(step));
    return put(len(1, cat(len(1, userId), ...stepIds.map((id) => len(2, id)))));
  };
  const assistant = (text: string, at: number) => len(1, cat(str(1, text), num(2, at)));
  // ToolCall.shell_tool_call(1) { args(1) ShellArgs{command(1)}, result(2) ShellResult{success(1){exit_code(3), stdout(5)}} }
  const shell = (command: string, id: string, at: number) =>
    len(
      2,
      cat(
        len(1, cat(len(1, str(1, command)), len(2, len(1, cat(num(3, 0), str(5, "total 0")))))),
        str(57, `${id}\nextra`),
        num(59, at),
      ),
    );
  // ToolCall.read_tool_call(8) { args(1) ReadToolArgs{path(1)}, result(2) ReadToolResult{success(1){content(1)}} }
  const read = len(
    2,
    cat(len(8, cat(len(1, str(1, "a.txt")), len(2, len(1, str(1, "hi"))))), str(57, "call-2")),
  );
  const thinking = len(3, cat(str(1, "pondering"), num(3, 1500)));
  const shellTurn = put(len(2, cat(str(1, "git status"), str(2, "clean"))));
  // Timestamps deliberately run backwards: turn 2's answer is "earlier" than turn 1.
  const t1 = turn("first question", [
    thinking,
    shell("ls -la", "call-1", 2000),
    read,
    assistant("answer one", 3000),
  ]);
  const t2 = turn("second question", [assistant("answer two", 1000)]);
  const rootId = put(cat(len(8, t1), len(8, shellTurn), len(8, t2)));
  return { blobs, rootId: rootId.toString("hex") };
}

const labels = (
  messages: ReadonlyArray<{
    kind: string;
    role?: string;
    text?: string;
    toolName?: string;
    command?: string;
  }>,
) =>
  messages.map((m) =>
    m.kind === "text"
      ? `${m.role}:${m.text}`
      : m.kind === "command"
        ? `command:${m.command}`
        : m.kind === "reasoning"
          ? `reasoning:${m.text}`
          : `tool:${m.toolName}`,
  );

describe("decodeConversationTree", () => {
  it("orders by root.turns and turn.steps, not timestamps or rows", () => {
    const { blobs, rootId } = buildTree();
    const map = new Map(blobs);
    const messages = decodeConversationTree((id) => map.get(id) ?? null, rootId);
    expect(labels(messages)).toEqual([
      "user:first question",
      "reasoning:pondering",
      "command:ls -la",
      "tool:read",
      "assistant:answer one",
      "command:git status",
      "user:second question",
      "assistant:answer two",
    ]);
    expect(messages[1]).toMatchObject({ kind: "reasoning", atMs: 1500 });
    expect(messages[2]).toMatchObject({
      kind: "command",
      toolCallId: "call-1",
      output: "total 0",
      exitCode: 0,
    });
    expect(messages[3]).toMatchObject({
      kind: "tool",
      toolCallId: "call-2",
      input: { path: "a.txt" },
      output: { success: { content: "hi" } },
    });
    expect(messages[5]).toMatchObject({ kind: "command", output: "clean", exitCode: null });
  });

  it("returns nothing for a missing root", () => {
    expect(decodeConversationTree(() => null, "00")).toEqual([]);
  });
});

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cursor-store-test-"));
const encrypt = (keyHex: string, plain: Uint8Array) => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv(
    "aes-256-gcm",
    sha(new TextEncoder().encode(keyHex)),
    iv,
  );
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
};
const writeStore = (file: string, blobs: Array<[string, Uint8Array]>, meta?: object) => {
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec(
    "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
  );
  for (const [id, data] of blobs) db.prepare("INSERT INTO blobs VALUES (?, ?)").run(id, data);
  if (meta) {
    db.prepare("INSERT INTO meta VALUES ('0', ?)").run(
      Buffer.from(JSON.stringify(meta)).toString("hex"),
    );
  }
  db.close();
};

describe("decodeCursorChatStore", () => {
  it("decrypts AES-GCM blobs, reads meta, never returns the key", async () => {
    const dir = tmp();
    const keyHex = "ab".repeat(32);
    const { blobs, rootId } = buildTree();
    const file = NodePath.join(dir, "store.db");
    writeStore(
      file,
      blobs.map(([id, data]) => [id, encrypt(keyHex, data)]),
      { agentId: "chat-1", name: "My chat", latestRootBlobId: rootId, blobEncryptionKey: keyHex },
    );
    const result = await decodeCursorChatStore(file);
    expect(result.agentId).toBe("chat-1");
    expect(result.title).toBe("My chat");
    expect(labels(result.messages)).toHaveLength(8);
    expect(JSON.stringify(result)).not.toContain(keyHex);
  });
});

describe("readCursorSdkAgent", () => {
  it("lists agents and decodes one agent's checkpoint tree", async () => {
    const root = tmp();
    const keyHex = "cd".repeat(32);
    const { blobs, rootId } = buildTree();
    const agentId = "agent-11111111-2222-3333-4444-555555555555";
    const agentDir = `agent-${NodeCrypto.createHash("sha256").update(agentId).digest("hex")}`;
    NodeFS.mkdirSync(NodePath.join(root, "agents", agentDir), { recursive: true });
    writeStore(
      NodePath.join(root, "agents", agentDir, "store.db"),
      blobs.map(([id, data]) => [id, encrypt(keyHex, data)]),
    );
    const index = new NodeSqlite.DatabaseSync(NodePath.join(root, "index.db"));
    index.exec(
      "CREATE TABLE agents (agent_id TEXT, workspace_ref TEXT, name TEXT, metadata_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT, updated_at TEXT)",
    );
    index
      .prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        agentId,
        "/work/repo",
        "My agent",
        JSON.stringify({ blobEncryptionKey: keyHex }),
        JSON.stringify({ blobId: rootId, storeKind: "local" }),
        "2026-10-01T00:00:00.000Z",
        "2026-10-02T00:00:00.000Z",
      );
    index.close();

    const listed = await readCursorSdkAgent(root, null);
    expect(listed.map((a) => [a.agentId, a.agentDir, a.cwd, a.messages.length])).toEqual([
      [agentId, agentDir, "/work/repo", 0],
    ]);
    const [full] = await readCursorSdkAgent(root, agentDir);
    expect(full === undefined ? [] : labels(full.messages)).toHaveLength(8);
    expect(JSON.stringify(full)).not.toContain(keyHex);
  });

  it("recognises T3-created agents by the adapter name template or createdBy", () => {
    expect(
      isT3CursorSdkAgent({ name: "T3 Code 29fe6246-604a-43db-b9aa-0123456789ab", createdBy: null }),
    ).toBe(true);
    expect(isT3CursorSdkAgent({ name: "New Agent", createdBy: "t3code" })).toBe(true);
    expect(isT3CursorSdkAgent({ name: "T3 Code notes", createdBy: null })).toBe(false);
  });
});
