// @effect-diagnostics nodeBuiltinImport:off -- Cursor hook processes reach T3 over loopback HTTP.
/**
 * Bridges Cursor's permission hooks to T3's approval UI.
 *
 * Cursor runs command hooks from `hooks.json` before shell commands, MCP
 * calls, file reads and tool calls (`beforeShellExecution`,
 * `beforeMCPExecution`, `beforeReadFile`, `preToolUse`), for local SDK agents
 * that load the `user`/`project` setting sources and for Self-Hosted Machines
 * workers. T3's hook script forwards each hook payload to this loopback
 * server, which asks the owning T3 session and answers `allow` or `deny`
 * once the user decides. Cursor's `ask` is not used: local SDK runs reject it
 * and `preToolUse` does not enforce it, so the hook blocks until T3 answers.
 *
 * See https://cursor.com/docs/agent/hooks.
 *
 * @module provider-cursor/server/CursorHookBridge
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const CURSOR_HOOK_URL_ENV = "T3_CURSOR_HOOK_URL";
export const CURSOR_HOOK_TOKEN_ENV = "T3_CURSOR_HOOK_TOKEN";
/** File name under the T3 state directory. */
export const CURSOR_HOOK_BRIDGE_STATE_FILE = "cursor-hook-bridge.json";
/** Worker env file under the T3 state directory, owner-only. */
export const CURSOR_WORKER_ENV_FILE = "cursor-worker.env";

export type CursorHookEventName =
  | "beforeShellExecution"
  | "beforeMCPExecution"
  | "beforeReadFile"
  | "preToolUse";

export const CURSOR_APPROVAL_HOOK_EVENTS: ReadonlyArray<CursorHookEventName> = [
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "preToolUse",
];

export interface CursorHookPayload {
  readonly hook_event_name?: string;
  readonly conversation_id?: string;
  readonly workspace_roots?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly command?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly mcp_server_name?: string;
  readonly file_path?: string;
}

/** What T3 asks the user, derived from one hook payload. */
export interface CursorApprovalQuestion {
  readonly event: CursorHookEventName;
  readonly kind: "command" | "file-read" | "file-change" | "permission";
  readonly title: string;
  readonly detail: string;
  readonly conversationId: string | undefined;
  readonly workspaceRoots: ReadonlyArray<string>;
}

export type CursorApprovalDecision = "allow" | "deny";

/** Tools that `preToolUse` gates; shell, MCP and reads have their own hooks. */
const GATED_PRE_TOOLS = new Set(["Write", "Delete", "Edit", "MultiEdit", "ApplyPatch"]);

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const pathOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "target_file", "filePath"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
};

/**
 * The question for a hook payload, or `null` when T3 should not ask (an
 * ungated tool on `preToolUse`, or an event T3 does not handle).
 */
export function approvalQuestionOf(payload: CursorHookPayload): CursorApprovalQuestion | null {
  const base = {
    conversationId: payload.conversation_id,
    workspaceRoots: [
      ...(payload.workspace_roots ?? []),
      ...(payload.cwd === undefined ? [] : [payload.cwd]),
    ],
  };
  switch (payload.hook_event_name) {
    case "beforeShellExecution":
      return {
        ...base,
        event: "beforeShellExecution",
        kind: "command",
        title: "Run command",
        detail: payload.command ?? "",
      };
    case "beforeMCPExecution":
      return {
        ...base,
        event: "beforeMCPExecution",
        kind: "permission",
        title: `Call MCP tool ${payload.mcp_server_name ?? "?"}/${payload.tool_name ?? "?"}`,
        detail: stringify(payload.tool_input ?? ""),
      };
    case "beforeReadFile":
      return {
        ...base,
        event: "beforeReadFile",
        kind: "file-read",
        title: "Read file",
        detail: payload.file_path ?? "",
      };
    case "preToolUse": {
      const tool = payload.tool_name ?? "";
      if (!GATED_PRE_TOOLS.has(tool)) return null;
      return {
        ...base,
        event: "preToolUse",
        kind: "file-change",
        title: tool === "Delete" ? "Delete file" : "Edit file",
        detail: pathOf(payload.tool_input) ?? stringify(payload.tool_input ?? ""),
      };
    }
    default:
      return null;
  }
}

/** The JSON a hook prints back to Cursor for a decision. */
export function hookResponseFor(
  event: CursorHookEventName | undefined,
  decision: CursorApprovalDecision,
  reason?: string,
): Record<string, unknown> {
  if (decision === "allow") {
    return event === "beforeShellExecution"
      ? { continue: true, permission: "allow" }
      : { permission: "allow" };
  }
  const message = reason ?? "Declined in T3 Code.";
  return {
    ...(event === "beforeShellExecution" ? { continue: true } : {}),
    permission: "deny",
    user_message: message,
    agent_message: `The user declined this action in T3 Code. ${message}`.trim(),
  };
}

export interface CursorApprovalSession {
  /** Cursor agent id of the session; hooks report it as `conversation_id` when they can. */
  readonly agentId: () => string | undefined;
  /** Workspace the session runs in; used when a hook carries no matching id. */
  readonly cwd: string | null;
  readonly decide: (question: CursorApprovalQuestion) => Promise<CursorApprovalDecision>;
}

const isInside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/**
 * The session that owns a question: the one whose agent id matches, else the
 * only session whose workspace contains the hook's workspace. Ambiguity means
 * no owner, so T3 never answers for the wrong thread.
 */
export function routeQuestion(
  sessions: ReadonlyArray<CursorApprovalSession>,
  question: CursorApprovalQuestion,
): CursorApprovalSession | undefined {
  if (question.conversationId !== undefined) {
    const byId = sessions.find((session) => session.agentId() === question.conversationId);
    if (byId !== undefined) return byId;
  }
  const byCwd = sessions.filter(
    (session) =>
      session.cwd !== null && question.workspaceRoots.some((root) => isInside(root, session.cwd!)),
  );
  return byCwd.length === 1 ? byCwd[0] : undefined;
}

export interface CursorHookBridge {
  readonly url: string;
  readonly token: string;
  readonly register: (session: CursorApprovalSession) => () => void;
  /** Answer for hook payloads no session claims (other Cursor clients). */
  readonly handle: (payload: CursorHookPayload) => Promise<Record<string, unknown> | null>;
  readonly close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

export interface CursorHookBridgeOptions {
  /** Asked for questions no T3 thread owns, e.g. Cursor agents launched from the agents page. */
  readonly fallback?: (question: CursorApprovalQuestion) => Promise<CursorApprovalDecision | null>;
  /** Fixed token, e.g. from {@link loadOrCreateBridgeState}; random otherwise. */
  readonly token?: string;
  /** Preferred port; a busy port falls back to a random one. */
  readonly port?: number;
}

export function startCursorHookBridge(
  options?: CursorHookBridgeOptions,
): Promise<CursorHookBridge> {
  const token = options?.token ?? NodeCrypto.randomBytes(24).toString("hex");
  const sessions = new Set<CursorApprovalSession>();

  const handle = async (payload: CursorHookPayload) => {
    const question = approvalQuestionOf(payload);
    if (question === null) return null;
    const owner = routeQuestion([...sessions], question);
    const decision =
      owner !== undefined
        ? await owner.decide(question)
        : ((await options?.fallback?.(question)) ?? null);
    return decision === null ? null : hookResponseFor(question.event, decision);
  };

  const server = NodeHttp.createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const expected = Buffer.from(`Bearer ${token}`);
    const given = Buffer.from(request.headers.authorization ?? "");
    if (
      request.method !== "POST" ||
      request.url !== "/cursor-hook" ||
      given.length !== expected.length ||
      !NodeCrypto.timingSafeEqual(given, expected)
    ) {
      reply(403, { error: "forbidden" });
      return;
    }
    const chunks: Array<Buffer> = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      let payload: CursorHookPayload;
      try {
        // Cursor on Windows can hand hooks a byte-order mark before the JSON.
        payload = JSON.parse(
          Buffer.concat(chunks)
            .toString("utf8")
            .replace(/^\uFEFF/, ""),
        ) as CursorHookPayload;
      } catch {
        reply(400, { error: "invalid json" });
        return;
      }
      handle(payload).then(
        // `null` tells the hook script nobody here owns it: stay neutral.
        (answer) => reply(200, { answer }),
        (cause) =>
          reply(200, {
            answer: hookResponseFor(
              approvalQuestionOf(payload)?.event,
              "deny",
              `T3 Code could not ask for approval: ${String(cause)}`,
            ),
          }),
      );
    });
  });
  // Approvals wait for a person; never time the hook request out server-side.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  const listen = (port: number) =>
    new Promise<void>((done, fail) => {
      const onError = (cause: NodeJS.ErrnoException) => fail(cause);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        done();
      });
    });
  const listening =
    options?.port === undefined
      ? listen(0)
      : listen(options.port).catch((cause: NodeJS.ErrnoException) =>
          cause.code === "EADDRINUSE" ? listen(0) : Promise.reject(cause),
        );

  return new Promise((resolve, reject) => {
    listening.then(() => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Cursor hook bridge has no TCP address."));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/cursor-hook`,
        token,
        register: (session) => {
          sessions.add(session);
          return () => {
            sessions.delete(session);
          };
        },
        handle,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    }, reject);
  });
}

export interface CursorHookBridgeState {
  readonly token: string;
  readonly port: number | null;
}

/**
 * Token and last port, kept so worker processes configured once keep working
 * after T3 restarts. Owner-only file (0600) in an owner-only directory on
 * POSIX; on Windows mode bits are ignored and the state directory's
 * user-profile ACL is what keeps other accounts out.
 */
export async function loadOrCreateBridgeState(file: string): Promise<CursorHookBridgeState> {
  try {
    const parsed = JSON.parse(
      await NodeFSP.readFile(file, "utf8"),
    ) as Partial<CursorHookBridgeState>;
    if (typeof parsed.token === "string" && parsed.token.length >= 32) {
      return { token: parsed.token, port: typeof parsed.port === "number" ? parsed.port : null };
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const state = { token: NodeCrypto.randomBytes(32).toString("hex"), port: null };
  await saveBridgeState(file, state);
  return state;
}

export async function saveBridgeState(file: string, state: CursorHookBridgeState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temp, file);
  await NodeFSP.chmod(file, 0o600);
}

/** Shell lines a worker needs to reach the bridge (`. file && agent worker start`). */
export function workerEnvFileContents(bridge: Pick<CursorHookBridge, "url" | "token">): string {
  return [
    "# Written by T3 Code. Load before `agent worker start` so Cursor hooks reach T3.",
    `export ${CURSOR_HOOK_URL_ENV}=${JSON.stringify(bridge.url)}`,
    `export ${CURSOR_HOOK_TOKEN_ENV}=${JSON.stringify(bridge.token)}`,
    "",
  ].join("\n");
}

let sharedBridge: Promise<CursorHookBridge> | undefined;
let sharedStateFile: string | undefined;
let sharedFallback: CursorHookBridgeOptions["fallback"];

/**
 * Persist the shared bridge's token and port in `stateFile`. Call before the
 * first {@link sharedCursorHookBridge}; later calls are ignored once started.
 */
export function configureSharedCursorHookBridge(options: {
  readonly stateFile?: string;
  readonly fallback?: CursorHookBridgeOptions["fallback"];
}): void {
  if (options.stateFile !== undefined && sharedBridge === undefined) {
    sharedStateFile = options.stateFile;
  }
  if (options.fallback !== undefined) sharedFallback = options.fallback;
}

export const sharedCursorHookBridgeStarted = () => sharedBridge !== undefined;

/**
 * The process-wide bridge. Hook processes the in-process SDK spawns inherit
 * `process.env`, so the URL and token are published there once.
 */
export function sharedCursorHookBridge(): Promise<CursorHookBridge> {
  sharedBridge ??= (async () => {
    const stateFile = sharedStateFile;
    const state = stateFile === undefined ? undefined : await loadOrCreateBridgeState(stateFile);
    const bridge = await startCursorHookBridge({
      fallback: (question) => sharedFallback?.(question) ?? Promise.resolve(null),
      ...(state === undefined ? {} : { token: state.token }),
      ...(state?.port == null ? {} : { port: state.port }),
    });
    if (stateFile !== undefined && state !== undefined) {
      const port = Number(new URL(bridge.url).port);
      if (port !== state.port) await saveBridgeState(stateFile, { token: state.token, port });
    }
    process.env[CURSOR_HOOK_URL_ENV] = bridge.url;
    process.env[CURSOR_HOOK_TOKEN_ENV] = bridge.token;
    return bridge;
  })();
  sharedBridge.catch(() => {
    sharedBridge = undefined;
  });
  return sharedBridge;
}
