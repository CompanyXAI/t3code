import { assert, describe, it } from "@effect/vitest";
import type { AgentOptions, ListAgentsOptions, Run, SDKAgent, SDKAgentInfo } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as CursorAgentDirectory from "./CursorAgentDirectory.ts";

const work = { accountId: "work", label: "Work team", apiKey: "key-work", localCwds: ["/repo"] };
const personal = { accountId: "personal", label: "Personal", apiKey: "key-personal" };

const info = (overrides: Partial<SDKAgentInfo> & Pick<SDKAgentInfo, "agentId">): SDKAgentInfo =>
  ({ name: overrides.agentId, summary: "", lastModified: 1, ...overrides }) as SDKAgentInfo;

const fakeRun = (id: string, status: Run["status"]): Run =>
  ({
    id,
    agentId: "a",
    status,
    stream: async function* () {
      yield { type: "assistant", text: `from ${id}` };
    },
  }) as unknown as Run;

const makeSdk = () => {
  const calls = {
    list: [] as Array<ListAgentsOptions>,
    create: [] as Array<AgentOptions>,
    cancel: [] as Array<{ runId: string; options: unknown }>,
  };
  const agent = (agentId: string): SDKAgent =>
    ({ agentId, send: async () => fakeRun(`${agentId}-run`, "running") }) as unknown as SDKAgent;
  const sdk: CursorAgentDirectory.CursorDirectorySdk = {
    list: async (options) => {
      calls.list.push(options);
      if (options.runtime === "local") {
        return { items: [info({ agentId: "local-1", runtime: "local", lastModified: 5 })] };
      }
      if (options.runtime === "cloud" && options.apiKey === "key-personal")
        throw new Error("plan has no cloud agents");
      if (options.cursor === undefined) {
        return {
          items: [
            info({
              agentId: "bc-cloud",
              runtime: "cloud",
              env: { type: "cloud" },
              lastModified: 3,
            }),
          ],
          nextCursor: "page-2",
        };
      }
      return {
        items: [
          info({
            agentId: "bc-pool",
            runtime: "cloud",
            env: { type: "pool", name: "gpu" },
            repos: ["https://github.com/acme/app"],
            metadata: { createdBy: "t3code" },
            lastModified: 9,
          }),
          info({ agentId: "bc-machine", runtime: "cloud", env: { type: "machine", name: "mbp" } }),
        ],
      };
    },
    create: async (options) => {
      calls.create.push(options);
      return agent("bc-new");
    },
    resume: async (agentId) => agent(agentId),
    listRuns: async () => ({
      items: [fakeRun("run-done", "finished"), fakeRun("run-live", "running")],
    }),
    cancelRun: async (runId, options) => {
      calls.cancel.push({ runId, options });
    },
  };
  return { sdk, calls };
};

describe("CursorAgentDirectory", () => {
  it.effect("lists local, cloud, pool and machine agents of every account in one view", () =>
    Effect.gen(function* () {
      const { sdk, calls } = makeSdk();
      const directory = CursorAgentDirectory.make(sdk);
      const { entries, failures } = yield* directory.listAgents([work, personal]);

      assert.deepStrictEqual(
        entries.map((entry) => [entry.agentId, entry.runtime, entry.runtimeLabel]),
        [
          ["bc-pool", "self-hosted-pool", "Self-hosted"],
          ["local-1", "local", "Local"],
          ["bc-cloud", "cloud", "Cloud"],
          ["bc-machine", "self-hosted-machine", "Self-hosted"],
        ],
      );
      const pool = entries[0]!;
      assert.equal(pool.environmentName, "gpu");
      assert.isTrue(pool.createdByT3);
      assert.equal(entries[1]!.cwd, "/repo");
      // Each account queries with its own key; the failing one does not hide the other.
      assert.isTrue(
        calls.list.some((options) => options.runtime === "cloud" && options.apiKey === "key-work"),
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.accountId, "personal");
    }),
  );

  it.effect("labels launched agents so Cursor shows their runtime", () =>
    Effect.gen(function* () {
      const { sdk, calls } = makeSdk();
      const directory = CursorAgentDirectory.make(sdk);
      const launched = yield* directory.launch({
        account: work,
        prompt: "fix the flaky test",
        name: "Flaky test",
        target: {
          runtime: "self-hosted-pool",
          repoUrl: "https://github.com/acme/app",
          environmentName: "gpu",
        },
      });
      assert.deepStrictEqual(launched, { agentId: "bc-new", runId: "bc-new-run" });
      const options = calls.create[0]!;
      assert.equal(options.name, "[T3 · Self-hosted] Flaky test");
      assert.equal(options.apiKey, "key-work");
      assert.deepStrictEqual(options.cloud?.env, { type: "pool", name: "gpu" });
      assert.deepStrictEqual(options.cloud?.metadata, {
        createdBy: "t3code",
        t3Runtime: "self-hosted-pool",
        t3Account: "work",
      });

      const local = directory.launchOptions({
        account: work,
        prompt: "x",
        name: "[T3 · Local] already labeled",
        target: { runtime: "local", cwd: "/repo" },
      });
      assert.equal(local.name, "[T3 · Local] already labeled");
      assert.isUndefined(local.cloud);
    }),
  );

  it.effect("stops the running run and follows the latest run", () =>
    Effect.gen(function* () {
      const { sdk, calls } = makeSdk();
      const directory = CursorAgentDirectory.make(sdk);
      const stopped = yield* directory.stop({ account: work, agentId: "bc-cloud" });
      assert.equal(stopped, "run-live");
      assert.deepStrictEqual(calls.cancel[0], {
        runId: "run-live",
        options: { runtime: "cloud", agentId: "bc-cloud", apiKey: "key-work" },
      });
      const messages = yield* Stream.runCollect(
        directory.follow({ account: work, agentId: "bc-cloud" }),
      );
      assert.equal(messages.length, 1);
    }),
  );
});

describe("CursorAgentDirectory follow-up stream", () => {
  it.effect("follows the newest run when local listRuns returns oldest first", () =>
    Effect.gen(function* () {
      // Local SDK order (proven on SCH99): oldest first, paged. A follow-up's
      // stream must be its own new run, not the agent's first one.
      const run = (id: string, createdAt: number) =>
        ({ ...fakeRun(id, "finished"), createdAt }) as unknown as Run;
      const pages: Record<string, { items: Array<Run>; nextCursor?: string }> = {
        first: { items: [run("run-first", 1), run("run-second", 2)], nextCursor: "p2" },
        p2: { items: [run("run-followup", 3)] },
      };
      const { sdk } = makeSdk();
      const directory = CursorAgentDirectory.make({
        ...sdk,
        listRuns: async (_agentId: string, options?: { cursor?: string }) =>
          pages[options?.cursor ?? "first"]!,
      } as typeof sdk);
      const messages = yield* Stream.runCollect(
        directory.follow({ account: work, agentId: "agent-local", cwd: "/repo" }),
      );
      assert.deepStrictEqual(
        [...messages].map((message) => (message as { text?: string }).text),
        ["from run-followup"],
      );
    }),
  );
});
describe("CursorAgentDirectory local worker", () => {
  it.effect("shows agents on this computer's My Machines worker as Local and launches there", () =>
    Effect.gen(function* () {
      const { sdk, calls } = makeSdk();
      const directory = CursorAgentDirectory.make(sdk);
      const { entries } = yield* directory.listAgents([{ ...work, ownMachineNames: ["mbp"] }]);
      const machine = entries.find((entry) => entry.agentId === "bc-machine")!;
      assert.equal(machine.runtime, "local-worker");
      assert.equal(machine.runtimeLabel, "Local");

      yield* directory.launch({
        account: work,
        prompt: "run locally, visible in Cursor",
        name: "Local task",
        target: {
          runtime: "local-worker",
          repoUrl: "https://github.com/acme/app",
          environmentName: "mbp",
        },
      });
      const options = calls.create[0]!;
      assert.equal(options.name, "[T3 · Local] Local task");
      assert.deepStrictEqual(options.cloud?.env, { type: "machine", name: "mbp" });
      assert.equal(options.cloud?.metadata?.t3Runtime, "local-worker");
    }),
  );
});
