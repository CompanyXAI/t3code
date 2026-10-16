import { describe, expect, it } from "vite-plus/test";

import { redactFreeText, splitSensitiveText } from "./redactFreeText";
import { INITIAL_REDACTION_STATE } from "./redactionReveal";

describe("splitSensitiveText", () => {
  it("finds paths with usernames, emails, URLs and known names in messages", () => {
    const text =
      "Worker failed in C:\\Users\\example\\dev\\app. Same Cursor account as Machine-Alpha-account-1, mail a@b.io, see https://x.ts.net/p and /home/dan/x.";
    const sensitive = splitSensitiveText(text, { accounts: ["Machine-Alpha-account-1"] })
      .filter((segment) => segment.category !== null)
      .map((segment) => [segment.category, segment.text]);
    expect(sensitive).toEqual([
      ["path", "C:\\Users\\example\\dev\\app"],
      ["email", "Machine-Alpha-account-1"],
      ["email", "a@b.io"],
      ["url", "https://x.ts.net/p"],
      ["path", "/home/dan/x"],
    ]);
  });

  it("keeps plain text untouched and rejoins to the original", () => {
    const text = "Account email unknown.";
    expect(splitSensitiveText(text)).toEqual([{ text, category: null }]);
    const mixed = "at C:\\Users\\x\\y, then stop";
    expect(
      splitSensitiveText(mixed)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(mixed);
  });
});

describe("redactFreeText", () => {
  it("replaces hidden pieces in tooltip strings", () => {
    const out = redactFreeText("Path C:\\Users\\example\\a.ts on Machine-Beta", INITIAL_REDACTION_STATE, {
      machines: ["Machine-Beta"],
    });
    expect(out).not.toContain("example");
    expect(out).not.toContain("SCH1");
    // Structure (separators) survives; the drive letter and names do not.
    expect(out).toMatch(/^Path .:\\/);
  });
});
