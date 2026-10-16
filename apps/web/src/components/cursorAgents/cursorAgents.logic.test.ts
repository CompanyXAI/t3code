import { describe, expect, it } from "vite-plus/test";

import {
  launchDraftProblem,
  matchesRuntimeFilter,
  parseMachineNames,
  repoLabel,
  runtimeBadge,
  workerSetupSteps,
  mergeStreamLines,
} from "./cursorAgents.logic";

const draft = {
  instanceId: "cursor",
  runtime: "local-worker" as const,
  name: "",
  prompt: "fix it",
  cwd: "",
  repoUrl: "https://github.com/acme/app",
  environmentName: "mbp",
};

describe("cursorAgents.logic", () => {
  it("labels every runtime", () => {
    const pool = runtimeBadge({ runtime: "self-hosted-pool", environmentName: "gpu" });
    expect(pool.label).toBe("Self-hosted Pool · gpu");
    expect(pool.kindLabel).toBe("Self-hosted Pool");
    expect(pool.environmentName).toBe("gpu");
    const worker = runtimeBadge({ runtime: "local-worker", environmentName: "mbp" });
    expect(worker.label).toBe("Local worker · mbp");
    expect(worker.kindLabel).toBe("Local worker");
    expect(worker.environmentName).toBe("mbp");
    const cloud = runtimeBadge({ runtime: "cloud", environmentName: null });
    expect(cloud.label).toBe("Cloud");
    expect(cloud.kindLabel).toBe("Cloud");
    expect(cloud.environmentName).toBeNull();
  });

  it("validates launch drafts per runtime", () => {
    expect(launchDraftProblem(draft)).toBeNull();
    expect(launchDraftProblem({ ...draft, environmentName: " " })).toMatch(/worker name/);
    expect(launchDraftProblem({ ...draft, runtime: "local" })).toMatch(/project folder/);
    expect(launchDraftProblem({ ...draft, runtime: "cloud", repoUrl: "" })).toMatch(/repository/);
  });

  it("filters, parses and formats", () => {
    const entry = { runtime: "local-worker" } as never;
    expect(matchesRuntimeFilter(entry, "local")).toBe(true);
    expect(matchesRuntimeFilter(entry, "cloud")).toBe(false);
    expect(parseMachineNames(" mbp, devbox ,")).toEqual(["mbp", "devbox"]);
    expect(repoLabel("https://github.com/acme/app.git")).toBe("acme/app");
  });
});

describe("workerSetupSteps", () => {
  it("sources the env file then starts the named worker", () => {
    const steps = workerSetupSteps(
      { envFile: "/home/d/.t3/cursor-worker.env", urlEnv: "U", tokenEnv: "T" },
      " daniels-mbp ",
    );
    expect(steps.map((step) => step.command)).toEqual([
      "set -a; . '/home/d/.t3/cursor-worker.env'; set +a",
      "agent worker start --name daniels-mbp",
    ]);
    expect(workerSetupSteps({ envFile: null, urlEnv: "U", tokenEnv: "T" }, "x")).toEqual([]);
  });
});

describe("mergeStreamLines", () => {
  it("joins consecutive assistant and thinking deltas but keeps other lines apart", () => {
    expect(
      mergeStreamLines([
        { kind: "status", text: "RUNNING" },
        { kind: "thinking", text: "a" },
        { kind: "thinking", text: "b" },
        { kind: "assistant", text: "O" },
        { kind: "assistant", text: "K" },
        { kind: "status", text: "FINISHED" },
        { kind: "status", text: "FINISHED" },
      ]),
    ).toEqual([
      { kind: "status", text: "RUNNING" },
      { kind: "thinking", text: "ab" },
      { kind: "assistant", text: "OK" },
      { kind: "status", text: "FINISHED" },
      { kind: "status", text: "FINISHED" },
    ]);
  });
});
