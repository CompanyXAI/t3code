import { describe, expect, it } from "vite-plus/test";

import { dropPerChatOptions } from "./composerDraftStore";

describe("dropPerChatOptions", () => {
  it("drops Runs on and keeps the model's own options", () => {
    const selection = {
      instanceId: "cursor_account_3",
      model: "default",
      options: [
        { id: "runsOn", value: "cloud" },
        { id: "fast", value: true },
      ],
    } as never;
    expect(dropPerChatOptions(selection).options).toEqual([{ id: "fast", value: true }]);
  });

  it("returns the same selection when there is nothing to drop", () => {
    const selection = { instanceId: "cursor_account_3", model: "default" } as never;
    expect(dropPerChatOptions(selection)).toBe(selection);
  });
});
