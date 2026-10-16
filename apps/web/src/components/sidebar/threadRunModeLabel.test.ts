import { describe, expect, it } from "vite-plus/test";

import { threadRunModeLabel } from "./threadRunModeLabel";

describe("threadRunModeLabel", () => {
  it("uses Cursor's runsOn option", () => {
    expect(threadRunModeLabel({ options: [{ id: "runsOn", value: "worker" }] }, false)).toBe(
      "Worker",
    );
    expect(threadRunModeLabel({ options: [{ id: "runsOn", value: "cloud" }] }, true)).toBe("Cloud");
    expect(threadRunModeLabel({ options: [{ id: "runsOn", value: "local" }] }, false)).toBe(
      "Local",
    );
  });
  it("falls back to this machine or a remote environment", () => {
    expect(threadRunModeLabel(undefined, false)).toBe("Local");
    expect(threadRunModeLabel({ options: [] }, true)).toBe("Remote");
  });
});
