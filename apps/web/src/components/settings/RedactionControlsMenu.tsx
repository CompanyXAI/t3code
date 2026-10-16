import { EyeIcon, EyeOffIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  REDACTION_CATEGORIES,
  REDACTION_CATEGORY_LABELS,
  isRevealAllOn,
  toggleRedactionCategory,
  toggleRevealAll,
  updateRedactionState,
  useRedactionState,
} from "./redactionReveal";

/** Header control: reveal sensitive text per category, or all at once. */
export function RedactionControlsMenu() {
  const state = useRedactionState();
  const revealAll = isRevealAllOn(state);
  const anyRevealed = REDACTION_CATEGORIES.some((category) => state.categories[category]);
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label="Show or blur sensitive text" />}>
        {anyRevealed ? (
          <EyeIcon className="size-4 text-primary" />
        ) : (
          <EyeOffIcon className="size-4 text-foreground" />
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={revealAll}
          onCheckedChange={() => updateRedactionState(toggleRevealAll)}
        >
          Reveal all
        </MenuCheckboxItem>
        <MenuSeparator />
        {REDACTION_CATEGORIES.map((category) => (
          <MenuCheckboxItem
            key={category}
            checked={state.categories[category]}
            onCheckedChange={() =>
              updateRedactionState((current) => toggleRedactionCategory(current, category))
            }
          >
            {REDACTION_CATEGORY_LABELS[category]}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
