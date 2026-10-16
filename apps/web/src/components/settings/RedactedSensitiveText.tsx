import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  isRedactionRevealed,
  redactionCategoryFor,
  redactionItemKey,
  toggleRedactionItem,
  updateRedactionState,
  useRedactionState,
  type RedactionCategory,
} from "./redactionReveal";

const REDACTED_TEXT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }

  const nextChar = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return REDACTED_TEXT_ALPHABET[Math.abs(state) % REDACTED_TEXT_ALPHABET.length] ?? "x";
  };

  return Array.from(value, (char) => {
    // Keep structure for emails, hosts, file paths, and URLs when blurred.
    if (
      char === "@" ||
      char === "." ||
      char === "-" ||
      char === "_" ||
      char === "/" ||
      char === "\\" ||
      char === ":"
    ) {
      return char;
    }
    return nextChar();
  }).join("");
}

/**
 * Non-interactive redaction for places where a reveal button cannot sit (inside a
 * label, link or button): the placeholder until the item or its category is
 * revealed via the header controls.
 */
export function useRedactedDisplay(
  category: RedactionCategory,
  value: string,
): { readonly revealed: boolean; readonly display: string } {
  const revealed = isRedactionRevealed(
    useRedactionState(),
    category,
    redactionItemKey(category, value.trim()),
  );
  return { revealed, display: revealed ? value : redactedPlaceholder(value) };
}

export function RedactedSensitiveText(props: {
  readonly value: string | null | undefined;
  readonly ariaLabel: string;
  readonly revealTooltip: string;
  readonly hideTooltip: string;
  readonly className?: string;
  /** Defaults to the category implied by the prop set's aria label. */
  readonly category?: RedactionCategory;
  /**
   * False inside another control (row button, select trigger/item): renders the
   * same text without its own reveal button, so buttons never nest. Reveal then
   * goes through the header controls, as with `useRedactedDisplay`.
   */
  readonly interactive?: boolean;
}) {
  const value = props.value?.trim();
  const category = props.category ?? redactionCategoryFor(props.ariaLabel);
  const itemKey = redactionItemKey(category, value ?? "");
  const revealed = isRedactionRevealed(useRedactionState(), category, itemKey);
  const redacted = useMemo(() => (value ? redactedPlaceholder(value) : ""), [value]);

  if (!value) return null;

  const className = cn(
    "min-w-0 rounded-sm font-mono text-2xs leading-normal",
    revealed ? "text-muted-foreground" : "select-none text-muted-foreground blur-xs",
    props.className,
  );
  if (props.interactive === false) {
    return <span className={className}>{revealed ? value : redacted}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn("cursor-pointer transition hover:text-foreground", className)}
            onClick={() =>
              updateRedactionState((state) => toggleRedactionItem(state, category, itemKey))
            }
            aria-label={props.ariaLabel}
          >
            {revealed ? value : redacted}
          </button>
        }
      />
      <TooltipPopup side="top">{revealed ? props.hideTooltip : props.revealTooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Click-to-reveal props for PC names, matching the email pattern. */
export const MACHINE_NAME_REDACT_PROPS = {
  ariaLabel: "Toggle machine name visibility",
  revealTooltip: "Click to reveal machine name",
  hideTooltip: "Click to hide machine name",
} as const;

/** Click-to-reveal props for hostnames and remote URLs (*.ts.net, etc.). */
export const HOST_URL_REDACT_PROPS = {
  ariaLabel: "Toggle host visibility",
  revealTooltip: "Click to reveal host",
  hideTooltip: "Click to hide host",
} as const;

/** Click-to-reveal props for local file paths (env files, repo roots, etc.). */
export const PATH_REDACT_PROPS = {
  ariaLabel: "Toggle path visibility",
  revealTooltip: "Click to reveal path",
  hideTooltip: "Click to hide path",
} as const;
