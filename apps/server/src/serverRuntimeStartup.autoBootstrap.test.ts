import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ServerSettings from "./serverSettings.ts";
import {
  getAutoBootstrapThreadModelSelection,
  resolveAutoBootstrapWelcomeTargets,
} from "./serverRuntimeStartup.ts";

const makeServerConfig = (cwd: string, paths: ServerConfig.ServerDerivedPaths) =>
  ({
    ...paths,
    baseDir: cwd,
    logLevel: "Error" as const,
    traceMinLevel: "Info" as const,
    traceTimingEnabled: false,
    traceBatchWindowMs: 200,
    traceMaxBytes: 1024,
    traceMaxFiles: 1,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    staticDir: undefined,
    devAllowedOrigins: [],
    desktopBootstrapToken: undefined,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    mode: "web" as const,
    cwd,
    host: undefined,
    port: 13773,
    devUrl: undefined,
    noBrowser: true,
    startupPresentation: "browser" as const,
    autoBootstrapProjectFromCwd: true,
  }) as ServerConfig.ServerConfig["Service"];

describe("resolveAutoBootstrapWelcomeTargets", () => {
  it.effect(
    "skips the welcome thread when the bootstrap instance is disabled for the project",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("bootstrap-project");
        const cwd = "C:\\Users\\example\\dev\\t3code";
        let launchCalls = 0;
        const paths = yield* ServerConfig.deriveServerPaths(cwd, undefined).pipe(
          Effect.provide(Path.layer),
        );

        const layer = Layer.mergeAll(
          Layer.mock(ServerConfig.ServerConfig)(makeServerConfig(cwd, paths)),
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: () =>
              Effect.succeed({
                project: {
                  id: projectId,
                  title: "t3code",
                  workspaceRoot: cwd,
                  repositoryIdentity: null,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-10-15T00:00:00.000Z",
                  updatedAt: "2026-10-15T00:00:00.000Z",
                  deletedAt: null,
                },
              } as never),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
            isProviderInstanceEnabledForProject: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: () => {
              launchCalls += 1;
              return Effect.fail(
                new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                  projectId,
                  instanceId: ProviderInstanceId.make("codex"),
                }),
              );
            },
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
          Path.layer,
          NodeCrypto.layer,
        );

        const targets = yield* resolveAutoBootstrapWelcomeTargets.pipe(Effect.provide(layer));
        assert.strictEqual(targets.bootstrapProjectId, projectId);
        assert.strictEqual(targets.bootstrapThreadId, undefined);
        assert.strictEqual(launchCalls, 0);
        assert.strictEqual(getAutoBootstrapThreadModelSelection().model, DEFAULT_MODEL);
        assert.strictEqual(
          getAutoBootstrapThreadModelSelection().instanceId,
          ProviderInstanceId.make("codex"),
        );
      }),
  );

  it.effect("catches a disabled-instance launch race without failing bootstrap", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("bootstrap-race-project");
      const cwd = "C:\\Users\\example\\dev\\t3code";
      const paths = yield* ServerConfig.deriveServerPaths(cwd, undefined).pipe(
        Effect.provide(Path.layer),
      );

      const layer = Layer.mergeAll(
        Layer.mock(ServerConfig.ServerConfig)(makeServerConfig(cwd, paths)),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: () =>
            Effect.succeed({
              project: {
                id: projectId,
                title: "t3code",
                workspaceRoot: cwd,
                repositoryIdentity: null,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-15T00:00:00.000Z",
                updatedAt: "2026-10-15T00:00:00.000Z",
                deletedAt: null,
              },
            } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: () =>
            Effect.fail(
              new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId: ProviderInstanceId.make("codex"),
              }),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Path.layer,
        NodeCrypto.layer,
      );

      const targets = yield* resolveAutoBootstrapWelcomeTargets.pipe(Effect.provide(layer));
      assert.strictEqual(targets.bootstrapProjectId, projectId);
      assert.strictEqual(targets.bootstrapThreadId, undefined);
    }),
  );
});
