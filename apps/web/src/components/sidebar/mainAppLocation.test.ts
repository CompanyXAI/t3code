import { describe, expect, it } from "vite-plus/test";

import { isSidebarUtilityPage } from "./mainAppLocation";

describe("isSidebarUtilityPage", () => {
  it("treats the Cursor agents home page as main app, so Back never targets it", () => {
    expect(isSidebarUtilityPage("/cursor-agents")).toBe(false);
  });

  it("keeps settings, usage and pull requests as utility pages", () => {
    for (const path of [
      "/settings",
      "/settings/general",
      "/usage",
      "/pull-requests",
      "/projects/x",
    ]) {
      expect(isSidebarUtilityPage(path)).toBe(true);
    }
  });
});
