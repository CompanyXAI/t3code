/**
 * Cursor has no native fork or account switch, and Cursor IDE chats cannot be
 * resumed: all of these start a new Cursor agent
 * and re-send the conversation as context, which costs tokens again. This
 * builds the confirmation text shown before such a handoff.
 */
export { estimateHandoffContextTokens } from "@t3tools/shared/usagePolicies";

export function cursorHandoffWarning(
  action: "fork" | "switch" | "import",
  usedTokens: number | null | undefined,
): string {
  const size =
    usedTokens != null && usedTokens > 0
      ? `roughly ${Math.max(1, Math.round(usedTokens / 1000)).toLocaleString("en-US")}k tokens`
      : "an unknown number of tokens";
  const what =
    action === "fork"
      ? "Forking this Cursor chat starts a new Cursor agent"
      : action === "switch"
        ? "Switching this chat to another Cursor account starts a new Cursor agent"
        : "This chat was imported from the Cursor IDE. Cursor offers no way to continue IDE chats from outside the IDE, so continuing here starts a new Cursor SDK agent seeded with the imported history. The original IDE chat stays unchanged. Sending";
  const verb = action === "import" ? " sends" : " and re-sends";
  return `${what}${verb} the conversation as context (${size}). This can cost many tokens.\n\nContinue?`;
}

/** Tooltip on the disabled resume control of a Cursor IDE import. */
export const CURSOR_IDE_IMPORT_RESUME_TOOLTIP =
  "Imported from Cursor IDE: it cannot be resumed. Sending starts a new Cursor SDK agent seeded with the imported history.";

/** Short thread badge label for Cursor IDE imports. */
export const CURSOR_IDE_IMPORT_BADGE_LABEL = "IDE import · continues as new agent";
