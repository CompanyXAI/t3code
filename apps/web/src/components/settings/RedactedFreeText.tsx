import { cn } from "../../lib/utils";
import { redactedPlaceholder } from "./RedactedSensitiveText";
import { splitSensitiveText, type FreeTextKnownValues } from "./redactFreeText";
import { isRedactionRevealed, redactionItemKey, useRedactionState } from "./redactionReveal";

/**
 * Free text (problem messages, worker status, account notes) with every email, URL,
 * local path and known machine/account name blurred under its category, so
 * messages obey the same blur menu as dedicated fields.
 */
export function RedactedFreeText(props: {
  readonly text: string;
  readonly known?: FreeTextKnownValues;
  readonly className?: string;
}) {
  const state = useRedactionState();
  return (
    <span className={props.className}>
      {splitSensitiveText(props.text, props.known).map((segment, index) => {
        if (segment.category === null) return <span key={index}>{segment.text}</span>;
        const revealed = isRedactionRevealed(
          state,
          segment.category,
          redactionItemKey(segment.category, segment.text),
        );
        return (
          <span key={index} className={cn(!revealed && "select-none blur-xs")}>
            {revealed ? segment.text : redactedPlaceholder(segment.text)}
          </span>
        );
      })}
    </span>
  );
}

/** Tooltip/title text with sensitive pieces replaced while their category is hidden. */
export { redactFreeText } from "./redactFreeText";
