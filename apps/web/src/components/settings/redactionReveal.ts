import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

/**
 * Reveal state for RedactedSensitiveText. Before this, each instance kept a local
 * `useState(false)` that reset on unmount; it is now shared and persisted in
 * localStorage via the existing useLocalStorage helpers. Items are keyed by a
 * hash of category + value, so no sensitive text is ever written to storage.
 */
export const REDACTION_CATEGORIES = ["email", "machine", "path", "url"] as const;
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];

export const REDACTION_CATEGORY_LABELS: Readonly<Record<RedactionCategory, string>> = {
  email: "Emails & accounts",
  machine: "Machine names",
  path: "Paths",
  url: "Hosts & URLs",
};

const Categories = Schema.Struct({
  email: Schema.Boolean,
  machine: Schema.Boolean,
  path: Schema.Boolean,
  url: Schema.Boolean,
});
const Snapshot = Schema.Struct({
  categories: Categories,
  items: Schema.Record(Schema.String, Schema.Boolean),
});
export const RedactionRevealState = Schema.Struct({
  categories: Categories,
  items: Schema.Record(Schema.String, Schema.Boolean),
  /** Set while "reveal all" is on: the exact state to restore when it is turned off. */
  revealAllSnapshot: Schema.NullOr(Snapshot),
});
export type RedactionRevealState = typeof RedactionRevealState.Type;

export const INITIAL_REDACTION_STATE: RedactionRevealState = {
  categories: { email: false, machine: false, path: false, url: false },
  items: {},
  revealAllSnapshot: null,
};

/** Maps the existing prop sets (by aria label) to a category. */
export function redactionCategoryFor(ariaLabel: string): RedactionCategory {
  const label = ariaLabel.toLowerCase();
  if (label.includes("path")) return "path";
  if (label.includes("machine")) return "machine";
  if (label.includes("host") || label.includes("url")) return "url";
  return "email";
}

export function redactionItemKey(category: RedactionCategory, value: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${category}\0${value}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${category}:${(hash >>> 0).toString(36)}`;
}

export function isRedactionRevealed(
  state: RedactionRevealState,
  category: RedactionCategory,
  itemKey: string,
): boolean {
  return state.items[itemKey] ?? state.categories[category];
}

export const isRevealAllOn = (state: RedactionRevealState) => state.revealAllSnapshot !== null;

export function toggleRedactionItem(
  state: RedactionRevealState,
  category: RedactionCategory,
  itemKey: string,
): RedactionRevealState {
  return {
    ...state,
    items: { ...state.items, [itemKey]: !isRedactionRevealed(state, category, itemKey) },
    // A manual change while "reveal all" is on keeps the snapshot so turning
    // "reveal all" off still restores the state from before it was turned on.
  };
}

export function toggleRedactionCategory(
  state: RedactionRevealState,
  category: RedactionCategory,
): RedactionRevealState {
  const prefix = `${category}:`;
  return {
    ...state,
    categories: { ...state.categories, [category]: !state.categories[category] },
    // The category switch applies to every item in it.
    items: Object.fromEntries(
      Object.entries(state.items).filter(([key]) => !key.startsWith(prefix)),
    ),
  };
}

export function toggleRevealAll(state: RedactionRevealState): RedactionRevealState {
  if (state.revealAllSnapshot !== null) {
    return { ...state.revealAllSnapshot, revealAllSnapshot: null };
  }
  return {
    categories: { email: true, machine: true, path: true, url: true },
    items: {},
    revealAllSnapshot: { categories: state.categories, items: state.items },
  };
}

const STORAGE_KEY = "t3code:redaction-reveal:v1";
const listeners = new Set<() => void>();
let current: RedactionRevealState | null = null;

function readState(): RedactionRevealState {
  if (current === null) {
    try {
      current = getLocalStorageItem(STORAGE_KEY, RedactionRevealState) ?? INITIAL_REDACTION_STATE;
    } catch {
      current = INITIAL_REDACTION_STATE;
    }
  }
  return current;
}

export function updateRedactionState(
  update: (state: RedactionRevealState) => RedactionRevealState,
): void {
  current = update(readState());
  try {
    setLocalStorageItem(STORAGE_KEY, current, RedactionRevealState);
  } catch {
    // Storage unavailable: keep the in-memory state.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useRedactionState(): RedactionRevealState {
  return useSyncExternalStore(subscribe, readState, () => INITIAL_REDACTION_STATE);
}
