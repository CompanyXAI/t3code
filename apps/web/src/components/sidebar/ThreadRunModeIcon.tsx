import { CloudIcon, GitBranchIcon, GlobeIcon, LaptopIcon, ServerIcon } from "lucide-react";

import { redactFreeText } from "../settings/redactFreeText";
import { useRedactionState } from "../settings/redactionReveal";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { threadRunModeLabel } from "./threadRunModeLabel";

type RunMode = ReturnType<typeof threadRunModeLabel>;

const RUN_MODE_ICON = {
  Local: LaptopIcon,
  Worker: ServerIcon,
  Cloud: CloudIcon,
  Remote: GlobeIcon,
} as const satisfies Record<RunMode, unknown>;

const RUN_MODE_DETAIL: Record<RunMode, string> = {
  Local: "This PC",
  Worker: "My worker",
  Cloud: "Cloud",
  Remote: "Remote environment",
};

/**
 * Compact run-mode marker (like Cursor's "Runs on" glyph): an icon only, with
 * mode, worktree, path, machine and account in its tooltip. Every sensitive
 * value in the tooltip follows the blur menu.
 */
export function ThreadRunModeIcon(props: {
  readonly mode: RunMode;
  readonly machine: string | null;
  readonly path: string | null;
  readonly worktree: boolean;
  readonly account: string | null;
}) {
  const redaction = useRedactionState();
  const Icon = props.worktree && props.mode === "Local" ? GitBranchIcon : RUN_MODE_ICON[props.mode];
  const known = {
    machines: props.machine === null ? [] : [props.machine],
    accounts: props.account === null ? [] : [props.account],
  };
  const lines = [
    `Runs on: ${RUN_MODE_DETAIL[props.mode]}${props.worktree ? " (worktree)" : ""}`,
    ...(props.machine === null ? [] : [`Machine: ${props.machine}`]),
    ...(props.path === null ? [] : [`${props.worktree ? "Worktree" : "Path"}: ${props.path}`]),
    ...(props.account === null ? [] : [`Account: ${props.account}`]),
  ].map((line) => redactFreeText(line, redaction, known));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 items-center"
            aria-label={`Runs on ${RUN_MODE_DETAIL[props.mode]}`}
          >
            <Icon aria-hidden className="size-3" />
          </span>
        }
      />
      <TooltipPopup side="top" className="whitespace-pre-line">
        {lines.join("\n")}
      </TooltipPopup>
    </Tooltip>
  );
}
