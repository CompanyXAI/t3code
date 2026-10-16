import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as CursorAgentDirectory from "@t3tools/provider-cursor/server/CursorAgentDirectory";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as CursorAgents from "./CursorAgents.ts";

const instance = (id: string, apiKey: string | null, driver = "cursor"): ProviderInstance =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make(driver),
    displayName: `Cursor ${id}`,
    enabled: true,
    agentDirectoryApiKey:
      apiKey === null
        ? Effect.fail(
            new ProviderDriverError({
              driver: ProviderDriverKind.make(driver),
              instanceId: ProviderInstanceId.make(id),
              detail: "Sign in to Cursor",
            }),
          )
        : Effect.succeed(apiKey),
  }) as unknown as ProviderInstance;

const makeService = (extraInstances: ReadonlyArray<ProviderInstance> = []) => {
  const keysSeen: Array<string | undefined> = [];
  const created: Array<unknown> = [];
  const directory = CursorAgentDirectory.make({
    list: async (options) => {
      if (options.runtime === "cloud") keysSeen.push(options.apiKey);
      return options.runtime === "cloud"
        ? {
            items: [
              {
                agentId: `bc-${options.apiKey}`,
                name: "[T3 · Local] task",
                summary: "",
                lastModified: 2,
                runtime: "cloud",
                env: { type: "machine", name: "daniels-mbp" },
              },
            ],
          }
        : { items: [] };
    },
    create: async (options) => {
      created.push(options);
      return {
        agentId: "bc-new",
        send: async () => ({
          id: "run-1",
          stream: async function* () {
            yield { type: "thinking", text: "planning" };
          },
        }),
      } as never;
    },
    resume: async () => ({ agentId: "bc-x", send: async () => ({ id: "run-2" }) }) as never,
    listRuns: async () =>
      ({
        items: [
          {
            id: "run-1",
            status: "running",
            stream: async function* () {
              yield { type: "status", status: "RUNNING" };
            },
          },
        ],
      }) as never,
    cancelRun: async () => undefined,
    accountEmail: async (apiKey) =>
      apiKey === "key-work" || apiKey === "key-work-2" ? "Daniel@Work.example" : undefined,
  });
  const service = CursorAgents.make({
    listInstances: Effect.succeed([
      instance("work", "key-work"),
      instance("personal", "key-personal"),
      instance("expired", null),
      instance("codex", "x", "codex"),
      ...extraInstances,
    ]),
    directory,
  });
  return { service, keysSeen, created };
};

describe("CursorAgents", () => {
  it.effect("lists every Cursor account with its own key and keeps failures per account", () =>
    Effect.gen(function* () {
      const { service, keysSeen } = makeService();
      const result = yield* service.list({ ownMachineNames: ["daniels-mbp"] });
      assert.deepStrictEqual(
        result.accounts.map((account) => account.instanceId),
        ["work", "personal", "expired"],
      );
      assert.deepStrictEqual(keysSeen.toSorted(), ["key-personal", "key-work"]);
      assert.equal(result.entries.length, 2);
      assert.deepStrictEqual(result.failures, [
        { instanceId: ProviderInstanceId.make("expired"), message: "Sign in to Cursor" },
      ]);
      assert.isTrue(result.entries.every((entry) => entry.runtime === "local-worker"));
      assert.isTrue(result.entries.every((entry) => entry.createdByT3));
    }),
  );

  it.effect("shows each login's account and flags two instances on one account", () =>
    Effect.gen(function* () {
      const plain = yield* makeService().service.list({});
      const work = plain.accounts.find((account) => account.instanceId === "work");
      assert.strictEqual(work?.email, "daniel@work.example");
      assert.strictEqual(work?.sharedWith, undefined);
      assert.strictEqual(
        plain.accounts.find((account) => account.instanceId === "personal")?.email,
        null,
      );
      const shared = yield* makeService([instance("work2", "key-work-2")]).service.list({});
      assert.deepStrictEqual(
        shared.accounts.find((account) => account.instanceId === "work")?.sharedWith,
        [ProviderInstanceId.make("work2")],
      );
    }),
  );

  it.effect("validates launch targets and launches on the own worker", () =>
    Effect.gen(function* () {
      const { service, created } = makeService();
      const missing = yield* service
        .launch({
          instanceId: ProviderInstanceId.make("work"),
          name: "x",
          prompt: "x",
          runtime: "local-worker",
          repoUrl: "https://github.com/acme/app",
        })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "CursorAgentsError");

      const launched = yield* service.launch({
        instanceId: ProviderInstanceId.make("work"),
        name: "Fix CI",
        prompt: "fix ci",
        runtime: "local-worker",
        repoUrl: "https://github.com/acme/app",
        environmentName: "daniels-mbp",
      });
      assert.deepStrictEqual(launched, { agentId: "bc-new", runId: "run-1" });
      assert.equal((created[0] as { name: string }).name, "[T3 · Local] Fix CI");
    }),
  );

  it.effect("stops and follows runs as display lines", () =>
    Effect.gen(function* () {
      const { service } = makeService();
      const target = { instanceId: ProviderInstanceId.make("work"), agentId: "bc-x" };
      assert.deepStrictEqual(yield* service.stop(target), { agentId: "bc-x", runId: "run-1" });
      const lines = yield* Stream.runCollect(service.follow(target));
      assert.deepStrictEqual(Array.from(lines), [{ kind: "status", text: "RUNNING" }]);
    }),
  );
});
