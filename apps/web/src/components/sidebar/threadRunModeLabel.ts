import type { ModelSelection } from "@t3tools/contracts";

/**
 * Where a thread's agent runs, for the sidebar row: Cursor's per-chat
 * "Runs on" option (local, worker, cloud), otherwise this machine or a
 * remote environment.
 */
export function threadRunModeLabel(
  modelSelection: Pick<ModelSelection, "options"> | null | undefined,
  isRemote: boolean,
): "Local" | "Worker" | "Cloud" | "Remote" {
  const runsOn = modelSelection?.options?.find((option) => option.id === "runsOn")?.value;
  if (runsOn === "worker") return "Worker";
  if (runsOn === "cloud") return "Cloud";
  return isRemote ? "Remote" : "Local";
}
