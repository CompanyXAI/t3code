import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type CursorAgentEntry } from "@t3tools/contracts";

import {
  accountOverview,
  blockedAccounts,
  knownWorkers,
  launchDraftProblem,
} from "./cursorAgents.logic";

const entry = (
  instanceId: string,
  runtime: CursorAgentEntry["runtime"],
  environmentName: string | null,
): CursorAgentEntry =>
  ({
    agentId: `bc-${Math.random()}`,
    instanceId: ProviderInstanceId.make(instanceId),
    runtime,
    environmentName,
  }) as CursorAgentEntry;

const accounts = [
  { instanceId: ProviderInstanceId.make("a"), label: "Account A", email: "a@x.com" },
  {
    instanceId: ProviderInstanceId.make("b"),
    label: "Account B",
    email: "a@x.com",
    sharedWith: [ProviderInstanceId.make("a")],
  },
  { instanceId: ProviderInstanceId.make("c"), label: "Account C", email: null },
];

describe("cursor account overview", () => {
  const overview = accountOverview(
    accounts,
    [
      entry("a", "local-worker", "Machine-Alpha"),
      entry("a", "local-worker", "Machine-Alpha"),
      entry("a", "self-hosted-machine", "Machine-Beta"),
      entry("a", "cloud", null),
      entry("b", "local-worker", "Machine-Alpha"),
    ],
    [{ instanceId: "c", message: "Sign in to Cursor" }],
  );

  it("groups machines per account and keeps accounts apart", () => {
    expect(overview[0]?.machines).toEqual([
      { name: "Machine-Alpha", runtime: "local-worker", agents: 2 },
      { name: "Machine-Beta", runtime: "self-hosted-machine", agents: 1 },
    ]);
    expect(overview[0]?.agents).toBe(4);
    expect(overview[1]?.machines).toEqual([
      { name: "Machine-Alpha", runtime: "local-worker", agents: 1 },
    ]);
    expect(knownWorkers(overview, "a", "self-hosted-machine")).toEqual(["Machine-Beta"]);
    expect(knownWorkers(overview, "b", "self-hosted-machine")).toEqual([]);
  });

  it("names shared logins and blocks launches from failing accounts", () => {
    expect(overview[1]?.sharedWith).toEqual(["Account A"]);
    const blocked = blockedAccounts(overview);
    expect([...blocked.keys()]).toEqual(["c"]);
    expect(
      launchDraftProblem(
        {
          instanceId: "c",
          runtime: "cloud",
          name: "",
          prompt: "x",
          cwd: "",
          repoUrl: "https://github.com/a/b",
          environmentName: "",
        },
        blocked,
      ),
    ).toBe("Account C: Sign in to Cursor");
  });
});
