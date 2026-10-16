import { describe, expect, it } from "vite-plus/test";

import { keepPerChatOptions } from "./composerDraftStore";

describe("keepPerChatOptions", () => {
  const next = { instanceId: "cursor_account_1", model: "default" } as never;

  it("carries the chat's Runs on into the new account's selection", () => {
    const current = {
      options: [
        { id: "runsOn", value: "worker" },
        { id: "fast", value: true },
      ],
    };
    expect(keepPerChatOptions(next, current as never).options).toEqual([
      { id: "runsOn", value: "worker" },
    ]);
  });

  it("leaves selections without per-chat options alone", () => {
    expect(keepPerChatOptions(next, { options: [] })).toBe(next);
    expect(keepPerChatOptions(next, undefined)).toBe(next);
  });
});
