import { describe, expect, it } from "@effect/vitest";
import {
  checkCursorAccounts,
  describeCursorAccountCheck,
  parseCursorCliStatusEmail,
} from "./accountGuard.ts";

describe("cursor account guard", () => {
  it("parses agent status output", () => {
    expect(parseCursorCliStatusEmail("✓ Logged in as a.b@example.com\n")).toBe("a.b@example.com");
    expect(parseCursorCliStatusEmail("Not logged in")).toBeUndefined();
    expect(parseCursorCliStatusEmail("something else")).toBeUndefined();
  });

  it("fails closed on anything but two equal emails", () => {
    expect(checkCursorAccounts("A@x.com", "a@x.com ").status).toBe("match");
    expect(checkCursorAccounts("a@x.com", "b@x.com")).toEqual({
      status: "mismatch",
      expected: "a@x.com",
      found: "b@x.com",
    });
    expect(checkCursorAccounts(undefined, "a@x.com").status).toBe("sdkEmailUnknown");
    expect(checkCursorAccounts("a@x.com", undefined).status).toBe("cliSignedOut");
    expect(describeCursorAccountCheck(checkCursorAccounts("a@x.com", "b@x.com"))).toContain(
      "b@x.com",
    );
  });
});
