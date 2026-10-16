import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_REDACTION_STATE,
  isRedactionRevealed,
  redactionCategoryFor,
  redactionItemKey,
  toggleRedactionCategory,
  toggleRedactionItem,
  toggleRevealAll,
} from "./redactionReveal";
import {
  HOST_URL_REDACT_PROPS,
  MACHINE_NAME_REDACT_PROPS,
  PATH_REDACT_PROPS,
} from "./RedactedSensitiveText";

describe("redactionReveal", () => {
  it("maps existing prop sets to categories", () => {
    expect(redactionCategoryFor(PATH_REDACT_PROPS.ariaLabel)).toBe("path");
    expect(redactionCategoryFor(MACHINE_NAME_REDACT_PROPS.ariaLabel)).toBe("machine");
    expect(redactionCategoryFor(HOST_URL_REDACT_PROPS.ariaLabel)).toBe("url");
    expect(redactionCategoryFor("Toggle account email visibility")).toBe("email");
  });

  it("does not put the value in the item key", () => {
    expect(redactionItemKey("email", "me@example.com")).not.toContain("example");
  });

  it("toggle-all restores the exact prior per-item and per-category state", () => {
    const item = redactionItemKey("email", "a@b.c");
    let state = toggleRedactionCategory(INITIAL_REDACTION_STATE, "path");
    state = toggleRedactionItem(state, "email", item);
    const before = { categories: state.categories, items: state.items };

    const all = toggleRevealAll(state);
    expect(isRedactionRevealed(all, "machine", redactionItemKey("machine", "pc"))).toBe(true);

    const restored = toggleRevealAll(all);
    expect({ categories: restored.categories, items: restored.items }).toEqual(before);
    expect(restored.revealAllSnapshot).toBeNull();
  });

  it("category toggle overrides item toggles in that category only", () => {
    const email = redactionItemKey("email", "a@b.c");
    const path = redactionItemKey("path", "/x");
    let state = toggleRedactionItem(INITIAL_REDACTION_STATE, "email", email);
    state = toggleRedactionItem(state, "path", path);
    state = toggleRedactionCategory(state, "email");
    expect(state.items).toEqual({ [path]: true });
    expect(isRedactionRevealed(state, "email", email)).toBe(true);
  });
});
