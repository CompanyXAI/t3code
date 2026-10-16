import { describe, expect, it } from "@effect/vitest";
import { describeCursorExistingLogin } from "./existingLogin.ts";

describe("describeCursorExistingLogin", () => {
  it("marks SDK logins as importable", () => {
    expect(describeCursorExistingLogin({ kind: "sdk", email: "a@example.com" })).toEqual({
      message: "Cursor SDK login found (a@example.com). Enable to use it.",
      authEmail: "a@example.com",
      importable: true,
    });
  });

  it("explains that a CLI session is not an Agent SDK key", () => {
    const described = describeCursorExistingLogin({ kind: "cli" });
    expect(described.importable).toBe(false);
    expect(described.message).toContain("signed in on this computer");
    expect(described.message).toContain("Agent SDK");
  });

  it("keeps the plain disabled copy when nothing is on disk", () => {
    expect(describeCursorExistingLogin({ kind: "none" }).message).toBe(
      "Cursor is disabled in T3 Code settings.",
    );
  });
});
