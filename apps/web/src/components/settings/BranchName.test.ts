import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));

import { branchContainsMachineName } from "./BranchName";

describe("branchContainsMachineName", () => {
  it("matches a machine label inside the branch, case-insensitively", () => {
    expect(branchContainsMachineName("machine-alpha/fix-blur", ["Machine-Alpha", "Machine-Beta"])).toBe(true);
    expect(branchContainsMachineName("feature/cursor-import", ["Machine-Alpha"])).toBe(false);
  });
  it("ignores blank or very short labels", () => {
    expect(branchContainsMachineName("main", ["", "ma"])).toBe(false);
  });
});
