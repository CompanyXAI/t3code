// @effect-diagnostics nodeBuiltinImport:off - node:sqlite + WebCrypto on copied store files.
/**
 * Read-only decoder for Cursor agent-kv stores (`~/.cursor/chats/<hash>/<agentId>/store.db`
 * and SDK `sdk-agent-store/<sha256(cwd)>/agents/agent-<sha256(agentId)>/store.db`).
 *
 * Evidence (cursor-agent bundle, agent-kv + agent/v1 protos, verified on SCH99 copies):
 * - tables `blobs(id, data)` and `meta(key, value)`; `meta["0"]` is hex(JSON) with
 *   agentId, name, latestRootBlobId and blobEncryptionKey.
 * - blob id = sha256(plaintext); a blob whose sha256 != id is AES-GCM (12-byte IV prefix,
 *   key = SHA-256 of the UTF-8 key string).
 * - ConversationStateStructure.turns = field 8 (32-byte blob ids, in order).
 *   ConversationTurnStructure: 1 agent turn (embedded), 2 shell turn.
 *   AgentConversationTurnStructure: 1 user_message (blob id), 2 steps (blob ids, in order).
 *   UserMessage.text = 1. ConversationStep: 1 assistant, 2 tool_call, 3 thinking.
 *   Every other message (tool args/results, thinking, shell turns) is decoded with the
 *   field names in cursorAgentProtoSchema.generated.ts, extracted from the same bundle.
 * Ordering comes only from the tree, never from row order or timestamps.
 * Stores are copied (with -wal/-shm) before opening; originals are never opened.
 * Encryption keys are never returned or logged.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { CURSOR_AGENT_PROTO_TYPES } from "./cursorAgentProtoSchema.generated.ts";

export type CursorStoreDbMessage =
  | {
      readonly kind: "text";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly atMs: number | null;
    }
  | { readonly kind: "reasoning"; readonly text: string; readonly atMs: number | null }
  | {
      /** Agent shell tool call or a user-run shell turn. */
      readonly kind: "command";
      readonly command: string;
      readonly output: string | null;
      readonly exitCode: number | null;
      readonly toolCallId: string | null;
      readonly atMs: number | null;
    }
  | {
      readonly kind: "tool";
      /** ToolCall oneof field name without `_tool_call`, e.g. `read`, `edit`, `mcp`. */
      readonly toolName: string;
      readonly toolCallId: string | null;
      /** Args message decoded with field names from the cursor-agent schema. */
      readonly input: unknown;
      /** Result message decoded the same way; null when the call has no result. */
      readonly output: unknown;
      readonly atMs: number | null;
    };

interface Field {
  readonly no: number;
  readonly wireType: number;
  readonly varint?: bigint;
  readonly bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let index = start;
  for (;;) {
    if (index >= buf.length) throw new Error("truncated varint");
    const byte = buf[index++]!;
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) return [result, index];
  }
}

/** Minimal protobuf wire decoder (varint, len, fixed32/64). Throws on malformed input. */
export function decodeProtoFields(buf: Uint8Array): ReadonlyArray<Field> {
  const fields: Array<Field> = [];
  let index = 0;
  while (index < buf.length) {
    const [key, afterKey] = readVarint(buf, index);
    index = afterKey;
    const no = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (wireType === 0) {
      const [value, next] = readVarint(buf, index);
      index = next;
      fields.push({ no, wireType, varint: value });
    } else if (wireType === 2 || wireType === 1 || wireType === 5) {
      let start = index;
      let end: number;
      if (wireType === 2) {
        const [length, next] = readVarint(buf, index);
        start = next;
        end = next + Number(length);
      } else {
        end = index + (wireType === 1 ? 8 : 4);
      }
      if (end > buf.length) throw new Error("truncated field");
      fields.push({ no, wireType, bytes: buf.subarray(start, end) });
      index = end;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

const safeFields = (buf: Uint8Array | null | undefined): ReadonlyArray<Field> => {
  if (!buf) return [];
  try {
    return decodeProtoFields(buf);
  } catch {
    return [];
  }
};
const firstBytes = (fields: ReadonlyArray<Field>, no: number) =>
  fields.find((field) => field.no === no && field.wireType === 2)?.bytes;
const firstVarint = (fields: ReadonlyArray<Field>, no: number) => {
  const value = fields.find((field) => field.no === no && field.varint !== undefined)?.varint;
  return value === undefined ? null : Number(value);
};
const utf8 = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? null : Buffer.from(bytes).toString("utf8");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const UTF8 = new TextDecoder("utf-8", { fatal: true });
/** Scalar type codes used by protobuf-es compact descriptors. */
function decodeScalar(code: number, field: Field): unknown {
  if (field.varint !== undefined) {
    const v = field.varint;
    if (code === 8) return v !== 0n;
    if (code === 17 || code === 18) return Number((v >> 1n) ^ -(v & 1n));
    if (code === 5 && v >= 0x80000000n) return Number(BigInt.asIntN(32, v));
    if (code === 3) return Number(BigInt.asIntN(64, v));
    return Number(v);
  }
  const bytes = field.bytes ?? new Uint8Array();
  if (field.wireType === 1 || field.wireType === 5) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (code === 1) return view.getFloat64(0, true);
    if (code === 2) return view.getFloat32(0, true);
    return field.wireType === 1 ? Number(view.getBigUint64(0, true)) : view.getUint32(0, true);
  }
  if (code === 9) return Buffer.from(bytes).toString("utf8");
  // bytes: text when it is valid UTF-8 without control noise, else hex (often blob ids).
  try {
    const text = UTF8.decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(text)) return text;
  } catch {}
  return hex(bytes);
}

const MAX_DECODE_DEPTH = 24;
/** Decode a message using field names from the cursor-agent bundle's schema. */
export function decodeNamedMessage(typeName: string, bytes: Uint8Array, depth = 0): unknown {
  const schema = CURSOR_AGENT_PROTO_TYPES[typeName];
  const fields = safeFields(bytes);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const spec = schema?.[String(field.no)];
    const key = spec?.name ?? String(field.no);
    let value: unknown;
    if (spec?.message !== undefined && field.wireType === 2 && depth < MAX_DECODE_DEPTH) {
      value = decodeNamedMessage(spec.message, field.bytes!, depth + 1);
    } else if (spec?.scalar !== undefined) {
      value = decodeScalar(spec.scalar, field);
    } else if (field.varint !== undefined) {
      value = Number(field.varint);
    } else {
      value = decodeScalar(12, field);
    }
    if (spec?.repeated) {
      const list = (out[key] as Array<unknown> | undefined) ?? [];
      list.push(value);
      out[key] = list;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type BlobReader = (idHex: string) => Uint8Array | null;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const asString = (value: unknown) => (typeof value === "string" ? value : null);
const asNumber = (value: unknown) => (typeof value === "number" ? value : null);

function decodeToolCall(bytes: Uint8Array): CursorStoreDbMessage {
  const fields = safeFields(bytes);
  const toolCall = CURSOR_AGENT_PROTO_TYPES.ToolCall ?? {};
  const kindField = fields.find((field) => toolCall[String(field.no)]?.oneof === "tool");
  const spec = kindField ? toolCall[String(kindField.no)] : undefined;
  const rawId = utf8(firstBytes(fields, 57));
  const toolCallId = rawId === null ? null : (rawId.split("\n")[0] ?? null);
  const atMs = firstVarint(fields, 59);
  const body = asRecord(
    spec?.message && kindField?.bytes ? decodeNamedMessage(spec.message, kindField.bytes) : {},
  );
  const toolName = spec ? spec.name.replace(/_tool_call$/, "") : `unknown_${kindField?.no ?? 0}`;
  if (toolName === "shell") {
    const args = asRecord(body.args);
    const result = asRecord(body.result);
    const outcome = asRecord(result.success ?? result.failure ?? result.timeout ?? {});
    const output =
      asString(outcome.interleaved_output) ??
      ([asString(outcome.stdout), asString(outcome.stderr)].filter(Boolean).join("\n") || null);
    return {
      kind: "command",
      command: asString(args.command) ?? "",
      output,
      exitCode: asNumber(outcome.exit_code),
      toolCallId,
      atMs,
    };
  }
  return {
    kind: "tool",
    toolName,
    toolCallId,
    input: body.args ?? body,
    output: body.result ?? null,
    atMs,
  };
}

/** Walk root -> turns -> (user message, steps) in tree order. */
export function decodeConversationTree(
  readBlob: BlobReader,
  rootIdHex: string,
): ReadonlyArray<CursorStoreDbMessage> {
  const root = safeFields(readBlob(rootIdHex));
  const messages: Array<CursorStoreDbMessage> = [];
  for (const turnRef of root.filter((field) => field.no === 8 && field.wireType === 2)) {
    const turn = safeFields(readBlob(hex(turnRef.bytes!)));
    const shellTurn = firstBytes(turn, 2);
    if (shellTurn !== undefined) {
      // ShellConversationTurnStructure: 1 shell_command, 2 shell_output (user-run `!cmd`).
      const shell = asRecord(decodeNamedMessage("ShellConversationTurnStructure", shellTurn));
      messages.push({
        kind: "command",
        command: asString(shell.shell_command) ?? "",
        output: asString(shell.shell_output),
        exitCode: null,
        toolCallId: null,
        atMs: null,
      });
      continue;
    }
    const agentTurn = safeFields(firstBytes(turn, 1));
    if (agentTurn.length === 0) continue;
    const stepMessages: Array<CursorStoreDbMessage> = [];
    for (const stepRef of agentTurn.filter((field) => field.no === 2 && field.wireType === 2)) {
      const step = safeFields(readBlob(hex(stepRef.bytes!)));
      const assistant = firstBytes(step, 1);
      const toolCall = firstBytes(step, 2);
      const thinking = firstBytes(step, 3);
      if (assistant !== undefined) {
        const fields = safeFields(assistant);
        const text = utf8(firstBytes(fields, 1)) ?? "";
        if (text.trim().length === 0) continue;
        stepMessages.push({ kind: "text", role: "assistant", text, atMs: firstVarint(fields, 2) });
      } else if (toolCall !== undefined) {
        stepMessages.push(decodeToolCall(toolCall));
      } else if (thinking !== undefined) {
        const fields = safeFields(thinking);
        const text = utf8(firstBytes(fields, 1)) ?? "";
        if (text.trim().length === 0) continue;
        stepMessages.push({ kind: "reasoning", text, atMs: firstVarint(fields, 3) });
      }
    }
    const userRef = firstBytes(agentTurn, 1);
    const userText =
      userRef === undefined ? null : utf8(firstBytes(safeFields(readBlob(hex(userRef))), 1));
    if (userText !== null && userText.trim().length > 0) {
      const firstAt = stepMessages.find((message) => message.atMs !== null)?.atMs ?? null;
      messages.push({ kind: "text", role: "user", text: userText, atMs: firstAt });
    }
    messages.push(...stepMessages);
  }
  return messages;
}

async function withCopy<A>(dbPath: string, use: (copy: string) => Promise<A>): Promise<A> {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-store-"));
  try {
    const copy = NodePath.join(dir, "store.db");
    NodeFS.copyFileSync(dbPath, copy);
    // The WAL holds recent blobs; without it the copy is incomplete (observed on SCH99).
    for (const suffix of ["-wal", "-shm"]) {
      if (NodeFS.existsSync(dbPath + suffix)) NodeFS.copyFileSync(dbPath + suffix, copy + suffix);
    }
    return await use(copy);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

const isKeyHex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

async function loadBlobReader(
  db: NodeSqlite.DatabaseSync,
  keyHex: string | null,
): Promise<BlobReader> {
  const key =
    keyHex === null
      ? null
      : await NodeCrypto.webcrypto.subtle.importKey(
          "raw",
          NodeCrypto.createHash("sha256").update(keyHex, "utf8").digest(),
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"],
        );
  const blobs = new Map<string, Uint8Array>();
  for (const row of db.prepare("SELECT id, data FROM blobs").all() as Array<{
    id: string;
    data: Uint8Array | null;
  }>) {
    if (row.data == null) continue;
    const raw = new Uint8Array(row.data);
    const id = String(row.id).toLowerCase();
    if (NodeCrypto.createHash("sha256").update(raw).digest("hex") === id) {
      blobs.set(id, raw);
      continue;
    }
    if (key === null || raw.byteLength < 28) continue;
    try {
      const plain = await NodeCrypto.webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: raw.subarray(0, 12) },
        key,
        raw.subarray(12),
      );
      blobs.set(id, new Uint8Array(plain));
    } catch {
      // Undecryptable blob: skipped.
    }
  }
  return (idHex) => blobs.get(idHex.toLowerCase()) ?? null;
}

/** Decode a chats store.db (via a temp copy). */
export function decodeCursorChatStore(dbPath: string): Promise<{
  readonly agentId: string | null;
  readonly title: string | null;
  readonly messages: ReadonlyArray<CursorStoreDbMessage>;
}> {
  return withCopy(dbPath, async (copy) => {
    const db = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as
        | { value: string }
        | undefined;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(Buffer.from(row?.value ?? "", "hex").toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {}
      const agentId = typeof meta.agentId === "string" ? meta.agentId : null;
      const title = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : null;
      const rootId = typeof meta.latestRootBlobId === "string" ? meta.latestRootBlobId : "";
      const keyHex = isKeyHex(meta.blobEncryptionKey) ? meta.blobEncryptionKey : null;
      const messages = rootId
        ? decodeConversationTree(await loadBlobReader(db, keyHex), rootId)
        : [];
      return { agentId, title, messages };
    } finally {
      db.close();
    }
  });
}

export interface CursorSdkAgentRecord {
  readonly agentId: string;
  /** `agent-<sha256(agentId)>` directory under `<storeRoot>/agents`. */
  readonly agentDir: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string | null;
  /** Only decoded when the caller asks for one agentDir. */
  readonly messages: ReadonlyArray<CursorStoreDbMessage>;
}

/**
 * T3 creates its own SDK agents; re-importing them would duplicate T3 threads.
 * Evidence: provider-cursor adapter names local agents `T3 Code ${threadId}` and tags
 * cloud agents with metadata createdBy "t3code".
 */
export function isT3CursorSdkAgent(record: Pick<CursorSdkAgentRecord, "name" | "createdBy">) {
  return (
    record.createdBy === "t3code" ||
    (record.name !== null &&
      /^T3 Code [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.name))
  );
}

/**
 * Read a local SDK store root (`.../sdk-agent-store/<hash>`) index.db. With `onlyAgentDir`
 * null every agent is listed without messages; otherwise only that agent is returned with
 * its checkpoint tree decoded from `agents/<agentDir>/store.db`.
 */
export async function readCursorSdkAgent(
  storeRoot: string,
  onlyAgentDir: string | null,
): Promise<ReadonlyArray<CursorSdkAgentRecord>> {
  const indexPath = NodePath.join(storeRoot, "index.db");
  if (!NodeFS.existsSync(indexPath)) return [];
  const rows = await withCopy(indexPath, async (copy) => {
    const db = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT agent_id, workspace_ref, name, metadata_json, latest_checkpoint_ref_json, created_at, updated_at FROM agents",
        )
        .all() as Array<Record<string, string | null>>;
    } finally {
      db.close();
    }
  });
  const out: Array<CursorSdkAgentRecord> = [];
  for (const row of rows) {
    const agentId = row.agent_id;
    const cwd = row.workspace_ref;
    if (!agentId || !cwd) continue;
    const agentDir = `agent-${NodeCrypto.createHash("sha256").update(agentId).digest("hex")}`;
    if (onlyAgentDir !== null && agentDir !== onlyAgentDir) continue;
    let keyHex: string | null = null;
    let createdBy: string | null = null;
    try {
      const metadata = JSON.parse(row.metadata_json ?? "{}") as Record<string, unknown>;
      if (isKeyHex(metadata.blobEncryptionKey)) keyHex = metadata.blobEncryptionKey;
      if (typeof metadata.createdBy === "string") createdBy = metadata.createdBy;
    } catch {}
    let rootId = "";
    try {
      const ref = JSON.parse(row.latest_checkpoint_ref_json ?? "{}") as { blobId?: unknown };
      if (typeof ref.blobId === "string") rootId = ref.blobId;
    } catch {}
    const storePath = NodePath.join(storeRoot, "agents", agentDir, "store.db");
    const messages =
      onlyAgentDir !== null && rootId && NodeFS.existsSync(storePath)
        ? await withCopy(storePath, async (copy) => {
            const db = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
            try {
              return decodeConversationTree(await loadBlobReader(db, keyHex), rootId);
            } finally {
              db.close();
            }
          })
        : [];
    out.push({
      agentId,
      agentDir,
      cwd,
      name: row.name ?? null,
      createdAt: row.created_at ?? "",
      updatedAt: row.updated_at ?? "",
      createdBy,
      messages,
    });
  }
  return out;
}
