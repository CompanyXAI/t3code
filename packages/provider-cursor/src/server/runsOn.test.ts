import { describe, expect, it } from "@effect/vitest";
import type { ModelSelection } from "@t3tools/contracts";

import { makeCursorAgentOptions } from "./adapter.ts";
import { agentMessagesFromRun } from "./CursorAgentSdk.ts";
import { cursorRunsOn, httpsRepoUrl, isCloudAgentId, workerNameOf } from "./runsOn.ts";
import { cursorSdkModelSelection } from "./sdkModel.ts";

const selection = (runsOn?: string) =>
  ({
    instanceId: "cursor",
    model: "composer-2",
    options: [
      { id: "fastMode", value: true },
      ...(runsOn === undefined ? [] : [{ id: "runsOn", value: runsOn }]),
    ],
  }) as unknown as ModelSelection;

const policy = { cwd: "C:/repo", interactionMode: "default", runtimeMode: "full-access" } as never;

describe("Cursor runs on", () => {
  it("defaults to local and reads worker or cloud", () => {
    expect(cursorRunsOn(selection())).toBe("local");
    expect(cursorRunsOn(selection("worker"))).toBe("worker");
    expect(cursorRunsOn(selection("cloud"))).toBe("cloud");
    expect(cursorRunsOn(selection("bogus"))).toBe("local");
  });

  it("never sends the T3 choice to Cursor as a model parameter", () => {
    expect(cursorSdkModelSelection(selection("worker")).params).toEqual([
      { id: "fast", value: "true" },
    ]);
  });

  it("hands Cursor an HTTPS repo url", () => {
    expect(httpsRepoUrl("git@github.com:example-org/Terminal.git")).toBe(
      "https://github.com/example-org/Terminal",
    );
    expect(httpsRepoUrl("ssh://git@github.com/org/repo.git")).toBe("https://github.com/org/repo");
    expect(httpsRepoUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("reads the worker name from its command line", () => {
    expect(workerNameOf('agent.exe worker start --name Machine-Alpha-account-3 --data-dir "C:/x"')).toBe(
      "Machine-Alpha-account-3",
    );
    expect(workerNameOf("agent.exe worker start --data-dir C:/x")).toBeUndefined();
    expect(isCloudAgentId("bc-123")).toBe(true);
    expect(isCloudAgentId("agent-123")).toBe(false);
  });

  it("creates worker agents on this account's machine with the project's repo", () => {
    const options = makeCursorAgentOptions({
      apiKey: "key",
      modelSelection: selection("worker"),
      runtimePolicy: policy,
      threadId: "thread-1" as never,
      mcpSession: undefined,
      target: {
        kind: "remote",
        runsOn: "worker",
        workerName: "Machine-Alpha-account-3",
        repoUrl: "https://github.com/org/repo.git",
        startingRef: "main",
        instanceId: "cursor-account-3",
      },
    });
    expect(options.local).toBeUndefined();
    expect(options.cloud?.env).toEqual({ type: "machine", name: "Machine-Alpha-account-3" });
    expect(options.cloud?.repos).toEqual([
      { url: "https://github.com/org/repo.git", startingRef: "main" },
    ]);
    expect(options.cloud?.metadata).toMatchObject({
      t3Account: "cursor-account-3",
      t3Thread: "thread-1",
    });
  });

  it("keeps local agents local and resumes remote ones without local options", () => {
    const local = makeCursorAgentOptions({
      modelSelection: selection(),
      runtimePolicy: policy,
      threadId: "thread-1" as never,
      mcpSession: undefined,
    });
    expect(local.local?.cwd).toBe("C:/repo");
    const resume = makeCursorAgentOptions({
      modelSelection: selection("cloud"),
      runtimePolicy: policy,
      threadId: "thread-1" as never,
      mcpSession: undefined,
      target: { kind: "remote-resume" },
    });
    expect(resume.local).toBeUndefined();
    expect(resume.cloud).toBeUndefined();
  });

  it("rebuilds a remote agent's turns from a replayed run", () => {
    const text = (value: string) => ({ type: "text", text: value });
    const replay = [
      { type: "user", message: { content: [text("Hallo")] } },
      { type: "thinking", text: "..." },
      { type: "assistant", message: { content: [text("Hi, ")] } },
      { type: "tool_call", name: "read", status: "completed" },
      { type: "assistant", message: { content: [text("fertig.")] } },
    ] as never;
    expect(agentMessagesFromRun("bc-1", "run-1", replay)).toEqual([
      { type: "user", uuid: "run-1:0", agent_id: "bc-1", message: { content: [text("Hallo")] } },
      {
        type: "assistant",
        uuid: "run-1:1",
        agent_id: "bc-1",
        message: { content: [text("Hi, fertig.")] },
      },
    ]);
  });
});
