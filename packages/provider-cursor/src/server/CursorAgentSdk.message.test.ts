import { describe, expect, it } from "vite-plus/test";

import { CursorAgentSdkRunnerError } from "./CursorAgentSdk.ts";

describe("CursorAgentSdkRunnerError", () => {
  it("names Cursor's reason when there is one", () => {
    expect(
      new CursorAgentSdkRunnerError({ method: "agent.create", cause: new Error("Unknown model.") })
        .message,
    ).toBe("Cursor Agent SDK agent.create failed: Unknown model.");
    expect(new CursorAgentSdkRunnerError({ method: "agent.create", cause: "x" }).message).toBe(
      "Cursor Agent SDK agent.create failed.",
    );
  });
});
