import { describe, expect, it } from "vite-plus/test";

import { cursorHandoffWarning, estimateHandoffContextTokens } from "./cursorHandoffWarning";

describe("cursorHandoffWarning", () => {
  it("names the action and the context size", () => {
    expect(cursorHandoffWarning("fork", 12_599)).toContain("Forking");
    expect(cursorHandoffWarning("fork", 12_599)).toContain("roughly 13k tokens");
    expect(cursorHandoffWarning("switch", null)).toContain("an unknown number of tokens");
    expect(cursorHandoffWarning("import", 2_000)).toContain("imported from the Cursor IDE");
    expect(cursorHandoffWarning("import", 2_000)).toContain(
      "new Cursor SDK agent seeded with the imported history",
    );
    expect(cursorHandoffWarning("import", 2_000)).not.toContain("re-sends");
  });
  it("prefers reported tokens, else estimates chars/4", () => {
    expect(estimateHandoffContextTokens(5_000, [{ text: "abc" }])).toBe(5_000);
    expect(estimateHandoffContextTokens(null, [{ text: "abcd" }, { text: "abcde" }])).toBe(3);
    expect(estimateHandoffContextTokens(0, [])).toBe(0);
  });
});
