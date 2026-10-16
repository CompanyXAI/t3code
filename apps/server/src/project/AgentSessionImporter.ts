import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  type ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { cursorToolItem } from "./cursorToolItems.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

/**
 * A Cursor `task`/`task_v2` call whose result names the spawned composer
 * (`result.agentId`, the same id as `additionalData.subagentComposerId`) becomes a
 * `subagent` turn item pointing at that composer's import thread, the item live
 * Codex/Claude subagents put in their parent. Without that id it stays a tool call.
 */
function cursorSubagentItem(
  common: Omit<
    Extract<OrchestrationV2TurnItem, { type: "subagent" }>,
    | "type"
    | "subagentId"
    | "origin"
    | "driver"
    | "providerInstanceId"
    | "childThreadId"
    | "prompt"
    | "result"
    | "progress"
  >,
  tool: NonNullable<AgentSessionScanner.AgentSessionThreadMessage["tool"]>,
  child:
    | { readonly driver: ProviderDriverKind; readonly providerInstanceId: ProviderInstanceId }
    | undefined,
): OrchestrationV2TurnItem | null {
  if (child === undefined || tool.kind !== "dynamic") return null;
  if (tool.name !== "task" && tool.name !== "task_v2") return null;
  const output = tool.output;
  const agentId =
    output !== null && typeof output === "object" && "agentId" in output
      ? (output as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== "string" || agentId.trim() === "") return null;
  const args =
    tool.input !== null && typeof tool.input === "object"
      ? (tool.input as Record<string, unknown>)
      : {};
  const prompt =
    typeof args.prompt === "string"
      ? args.prompt
      : typeof args.description === "string"
        ? args.description
        : "";
  return {
    ...common,
    type: "subagent",
    subagentId: NodeId.make(`${IMPORT_EVENT_PREFIX}:subagent:${agentId}`),
    origin: "provider_native",
    driver: child.driver,
    providerInstanceId: child.providerInstanceId,
    childThreadId: ThreadId.make(`import:${child.providerInstanceId}:${agentId}`),
    prompt,
    result: null,
  };
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
  /** Set for Cursor imports: links a Task call to its subagent's import thread. */
  readonly subagentChild?: {
    readonly driver: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
  };
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const tool = input.message.tool;
  if (tool !== undefined || input.message.reasoning === true) {
    const toolItem: OrchestrationV2TurnItem =
      tool === undefined
        ? { ...common, type: "reasoning", text: input.message.text, streaming: false }
        : tool.kind === "command"
          ? {
              ...common,
              type: "command_execution",
              input: tool.command,
              ...(tool.output === null ? {} : { output: tool.output }),
              ...(tool.exitCode === null
                ? {}
                : { exitCode: tool.exitCode, outputIndicatesFailure: tool.exitCode !== 0 }),
            }
          : (cursorSubagentItem(common, tool, input.subagentChild) ?? {
              ...common,
              ...cursorToolItem(tool.name, tool.input, tool.output),
            });
    return [
      {
        id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        occurredAt: at,
        payload: toolItem,
      },
    ];
  }
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

/** Upper bound on import passes (each takes at most the scanner's per-pass batch). */
const MAX_IMPORT_PASSES = 1_000;

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    // The scanner hands out at most MAX_IMPORT_TRANSCRIPTS new sessions per pass; repeat
    // until a pass imports nothing new, so every session is imported in batches.
    const importedThreadIds = new Set<ThreadId>();
    let skippedCount = 0;
    for (let pass = 0; pass < MAX_IMPORT_PASSES; pass += 1) {
      let newlyImported = 0;
      skippedCount = 0;
      const runtimeRows = yield* runtimes
        .list()
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );
      const completedSources = runtimeRows.flatMap((runtime) => {
        const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
        if (
          Option.isNone(payload) ||
          payload.value.cwd === undefined ||
          normalizeProjectPathForComparison(payload.value.cwd) !==
            normalizeProjectPathForComparison(project.workspaceRoot)
        ) {
          return [];
        }
        return payload.value.importedTranscripts ?? [];
      });
      const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);

      yield* Stream.runForEach(outcomes, (outcome) =>
        Effect.gen(function* () {
          if (outcome._tag === "Skipped") {
            skippedCount += 1;
            return;
          }
          const source = outcome.source;
          const threadId = ThreadId.make(
            `import:${source.providerInstanceId}:${source.providerSessionId}`,
          );
          if (outcome._tag === "AlreadyImported") {
            importedThreadIds.add(threadId);
            return;
          }
          if (outcome._tag === "Duplicate") {
            if (importedThreadIds.has(threadId)) {
              yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
            }
            return;
          }

          const imported = yield* Effect.gen(function* () {
            const thread = outcome.thread;
            if (
              thread.source === "claudeAgent" &&
              !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
            ) {
              return yield* new AgentSessionUnresumableSessionError({
                source: thread.source,
                providerSessionId: thread.providerSessionId,
              });
            }
            const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
            if (Option.isSome(existing)) {
              if (existing.value.thread.projectId !== input.projectId) {
                return yield* new AgentSessionThreadProjectConflictError({
                  threadId,
                  expectedProjectId: input.projectId,
                  actualProjectId: existing.value.thread.projectId,
                });
              }
              if (existing.value.thread.historyOrigin !== "v1_import") {
                return yield* new AgentSessionThreadModifiedError({ threadId });
              }
              yield* runtimes.recordImportedTranscript({ threadId, source });
              return true;
            }

            const driver = ProviderDriverKind.make(thread.source);
            // Cursor: only local SDK `agent-*` ids resume (proven on SCH99); the adapter
            // throws on a provider thread without nativeThreadRef, so chats/transcript imports
            // get no provider thread and the first send creates a fresh agent.
            const nativeResumeId =
              thread.source === "cursor"
                ? (thread.cursorResumeAgentId ?? null)
                : thread.providerSessionId;
            const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
            const providerThreadId = idAllocator.derive.providerThread({
              driver,
              nativeThreadId: nativeResumeId ?? thread.providerSessionId,
            });
            const createdAt = dateTime(thread.createdAt);
            const updatedAt = dateTime(thread.updatedAt);
            // Cursor IDE: a subagent composer becomes a child thread of its parent composer's
            // import thread, the same lineage live Codex/Claude subagents get.
            const ideParentThreadId =
              thread.cursorIde?.parentSessionId == null
                ? null
                : ThreadId.make(
                    `import:${source.providerInstanceId}:${thread.cursorIde.parentSessionId}`,
                  );
            const importedTitle = thread.title.trim() === "" ? "Untitled thread" : thread.title;
            const appThread: OrchestrationV2AppThread = {
              createdBy: "system",
              creationSource: "server",
              id: threadId,
              projectId: input.projectId,
              title: thread.cursorIde?.draft ? `[Draft] ${importedTitle}` : importedTitle,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: { instanceId: thread.providerInstanceId, model },
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              linkedPullRequest: null,
              branchPullRequest: null,
              activeProviderThreadId: nativeResumeId === null ? null : providerThreadId,
              historyOrigin: "v1_import",
              ...(thread.source === "cursor" && nativeResumeId === null
                ? { nativeResumeUnavailable: "cursor_ide_import" as const }
                : {}),
              lineage: {
                parentThreadId: ideParentThreadId,
                relationshipToParent: ideParentThreadId === null ? null : "subagent",
                // The top of the chain, so nested subagents share their main thread's root.
                rootThreadId:
                  thread.cursorIde?.rootSessionId == null
                    ? threadId
                    : ThreadId.make(
                        `import:${source.providerInstanceId}:${thread.cursorIde.rootSessionId}`,
                      ),
              },
              forkedFrom: null,
              createdAt,
              updatedAt,
              archivedAt: thread.cursorIde?.archived ? updatedAt : null,
              settledOverride: "settled",
              settledAt: updatedAt,
              unsettledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              pinnedAt: null,
              pinOrderKey: null,
              activeOrderKey: null,
              lastVisitedAt: null,
              deletedAt: null,
            };
            const providerThread: OrchestrationV2ProviderThread = {
              id: providerThreadId,
              driver,
              providerInstanceId: thread.providerInstanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: nativeResumeId ?? thread.providerSessionId,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt,
              updatedAt,
            };

            yield* runtimes.upsert(
              {
                threadId,
                providerName: driver,
                providerInstanceId: thread.providerInstanceId,
                adapterKey: driver,
                runtimeMode: DEFAULT_RUNTIME_MODE,
                status: "stopped",
                lastSeenAt: thread.updatedAt,
                resumeCursor:
                  thread.source === "codex"
                    ? { threadId: thread.providerSessionId }
                    : thread.source === "cursor"
                      ? // Proven on SCH99: Agent.resume only accepts SDK `agent-*` ids from
                        // its own store; transcript / chats UUIDs fail with agent_not_found.
                        nativeResumeId === null
                        ? { threadId }
                        : { threadId, resume: nativeResumeId }
                      : { threadId, resume: thread.providerSessionId },
                runtimePayload: { cwd: project.workspaceRoot },
              },
              { onConflict: "ignore" },
            );
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                  type: "thread.created",
                  threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: createdAt,
                  payload: appThread,
                },
                ...thread.messages.flatMap((message, index) =>
                  messageEvents({
                    threadId,
                    index,
                    message,
                    ...(thread.source === "cursor"
                      ? { subagentChild: { driver, providerInstanceId: thread.providerInstanceId } }
                      : {}),
                  }),
                ),
                ...(nativeResumeId === null
                  ? []
                  : [
                      {
                        id: EventId.make(
                          `${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`,
                        ),
                        type: "provider-thread.updated" as const,
                        threadId,
                        driver,
                        providerInstanceId: thread.providerInstanceId,
                        occurredAt: updatedAt,
                        payload: providerThread,
                      },
                    ]),
              ],
            });
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not import an agent session", {
                provider: outcome.thread.source,
                sessionId: outcome.thread.providerSessionId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
          if (imported) {
            importedThreadIds.add(threadId);
            newlyImported += 1;
          } else {
            skippedCount += 1;
          }
        }),
      );
      if (newlyImported === 0 || skippedCount === 0) break;
    }

    return {
      importedCount: importedThreadIds.size,
      skippedCount,
    } satisfies AgentSessionImportResult;
  });

  return { importRecentAgentThreads };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
