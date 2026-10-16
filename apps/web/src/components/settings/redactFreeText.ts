import {
  isRedactionRevealed,
  redactionItemKey,
  type RedactionCategory,
  type RedactionRevealState,
} from "./redactionReveal";
import { redactedPlaceholder } from "./RedactedSensitiveText";

export interface FreeTextSegment {
  readonly text: string;
  /** Null for plain text; otherwise the blur category of this piece. */
  readonly category: RedactionCategory | null;
}

/** Extra values to blur wherever they appear (account labels, machine names). */
export interface FreeTextKnownValues {
  readonly machines?: ReadonlyArray<string>;
  readonly accounts?: ReadonlyArray<string>;
}

const PATTERNS: ReadonlyArray<{ readonly category: RedactionCategory; readonly source: string }> = [
  { category: "email", source: String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+` },
  { category: "url", source: String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+` },
  // Windows drive paths, UNC paths and POSIX home paths (they carry the username).
  { category: "path", source: String.raw`(?:\b[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*` },
  { category: "path", source: String.raw`~?\/(?:home|Users|root)\/[^\s"'<>|]*` },
  { category: "path", source: String.raw`~[\\/][^\s"'<>|]*` },
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Splits free text (problem messages, tooltips, "Same Cursor account as …") into
 * plain and sensitive pieces: emails, URLs, local paths (with the username in
 * them) and the given machine/account names. Trailing sentence punctuation stays plain.
 */
export function splitSensitiveText(
  text: string,
  known: FreeTextKnownValues = {},
): ReadonlyArray<FreeTextSegment> {
  const sources = [
    ...(known.machines ?? [])
      .filter((value) => value.trim().length > 1)
      .map((value) => ({ category: "machine" as const, source: escapeRegExp(value.trim()) })),
    ...(known.accounts ?? [])
      .filter((value) => value.trim().length > 1)
      .map((value) => ({ category: "email" as const, source: escapeRegExp(value.trim()) })),
    ...PATTERNS,
  ];
  if (text.length === 0) return [];
  const combined = new RegExp(sources.map((entry) => `(${entry.source})`).join("|"), "g");
  const segments: Array<FreeTextSegment> = [];
  let last = 0;
  for (const match of text.matchAll(combined)) {
    let value = match[0];
    const group = match.slice(1).findIndex((part) => part !== undefined);
    const category = sources[group]?.category ?? null;
    if (category === "path" || category === "url") {
      const trimmed = value.replace(/[.,;:!?)\]]+$/, "");
      value = trimmed.length > 0 ? trimmed : value;
    }
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start), category: null });
    segments.push({ text: value, category });
    last = start + value.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), category: null });
  return segments;
}

/** Plain-string redaction for tooltips and titles: hidden pieces become placeholders. */
export function redactFreeText(
  text: string,
  state: RedactionRevealState,
  known: FreeTextKnownValues = {},
): string {
  return splitSensitiveText(text, known)
    .map((segment) =>
      segment.category === null ||
      isRedactionRevealed(state, segment.category, redactionItemKey(segment.category, segment.text))
        ? segment.text
        : redactedPlaceholder(segment.text),
    )
    .join("");
}
