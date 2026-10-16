import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CursorSettings } from "../settings.ts";
import { CursorProviderCapabilitiesV2, makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const steerScenario = (options: {
  readonly runSupportsSteer: boolean;
  readonly outcome: "complete_delivered" | "revert_to_followup";
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-steer-" });
    const release = yield* Deferred.make<void>();
    const steered: Array<string> = [];
    let cancelled = 0;
    const instanceId = ProviderInstanceId.make("cursor");
    const threadId = ThreadId.make("cursor-steer-thread");
    const modelSelection = { instanceId, model: "composer-2.5" };
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: workspace,
    });
    const adapter = yield* makeCursorAdapterV2({
      instanceId,
      settings: yield* decodeCursorSettings({}),
      environment: { HOME: workspace },
    }).pipe(
      Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
        assertComplete: Effect.void,
        open: () =>
          Effect.succeed({
            agentId: "native-cursor-steer",
            listMessages: Effect.succeed([]),
            close: Effect.void,
            send: () =>
              Effect.succeed({
                agentId: "native-cursor-steer",
                runId: "native-cursor-steer-run",
                wait: Deferred.await(release).pipe(
                  Effect.as({
                    id: "native-cursor-steer-run",
                    status: "finished" as const,
                    model: { id: "composer-2.5" },
                    durationMs: 1,
                  }),
                ),
                cancel: Effect.sync(() => {
                  cancelled += 1;
                }),
                ...(options.runSupportsSteer
                  ? {
                      steer: (text: string) =>
                        Effect.sync(() => {
                          steered.push(text);
                          return options.outcome;
                        }),
                    }
                  : {}),
              }),
          }),
      }),
      Effect.provide(TestProviderHost.layer({ cwd: workspace })),
    );
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("cursor-steer-session"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make("cursor-steer-run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("cursor-steer-attempt"),
      rootNodeId: NodeId.make("cursor-steer-root"),
      appThread: {
        id: threadId,
        projectId: ProjectId.make("cursor-steer-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor steering",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      message: {
        messageId: MessageId.make("cursor-steer-message"),
        createdBy: "user",
        creationSource: "web",
        text: "start",
        attachments: [],
      },
    });
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerTurnId = idAllocator.derive.providerTurn({
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      nativeTurnId: "native-cursor-steer-run",
    });
    const result = yield* runtime
      .steerTurn({
        threadId,
        runId: RunId.make("cursor-steer-run"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("cursor-steer-followup"),
          createdBy: "user",
          creationSource: "web",
          text: "also add tests",
          attachments: [],
        },
      })
      .pipe(Effect.result);
    yield* Deferred.succeed(release, undefined);
    return { result, steered, cancelled };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  );

describe("CursorAdapterV2 steering", () => {
  it("advertises active steering", () => {
    assert.isTrue(CursorProviderCapabilitiesV2.turns.supportsActiveSteering);
  });

  it.effect("steers the live run without cancelling it", () =>
    Effect.gen(function* () {
      const { result, steered, cancelled } = yield* steerScenario({
        runSupportsSteer: true,
        outcome: "complete_delivered",
      });
      assert.equal(result._tag, "Success");
      assert.deepStrictEqual(steered, ["also add tests"]);
      assert.equal(cancelled, 0);
    }),
  );

  it.effect.each([
    { runSupportsSteer: true, outcome: "revert_to_followup" as const },
    { runSupportsSteer: false, outcome: "complete_delivered" as const },
  ])("falls back to restart steering (steer=$runSupportsSteer, $outcome)", (options) =>
    Effect.gen(function* () {
      const { result, cancelled } = yield* steerScenario(options);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterSteerRunUnsupportedError");
      }
      assert.equal(cancelled, 0);
    }),
  );
});
