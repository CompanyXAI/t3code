import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
// Shape of the first 80 turn items of a real imported Cursor IDE chat (c175c682…):
// item types, tool names, statuses and timestamps only; every text value is "x".
import shape from "./cursorImportShape.fixture.json";

const visibleTurnItems = (shape as Array<Record<string, unknown>>).map((raw, position) => ({
  position,
  visibility: "local" as const,
  sourceThreadId: raw.threadId,
  sourceItemId: raw.id,
  item: {
    ...raw,
    startedAt: DateTime.makeUnsafe(raw.startedAt as string),
    completedAt: DateTime.makeUnsafe(raw.completedAt as string),
    updatedAt: DateTime.makeUnsafe(raw.updatedAt as string),
  },
}));

describe("imported Cursor IDE thread", () => {
  it("groups runless imported tool calls inside each folded turn", () => {
    const timelineEntries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: visibleTurnItems as never,
      optimisticMessages: [],
    });
    const base = {
      timelineEntries,
      latestRun: null,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const collapsed = deriveMessagesTimelineRows(base);
    const folds = collapsed.flatMap((row) => (row.kind === "turn-fold" ? [row.runId] : []));
    expect(folds).toHaveLength(2);
    // Collapsed, settled work sits behind "Worked for …" and shows no tool rows.
    expect(collapsed.some((row) => row.kind === "work" || row.kind === "work-toggle")).toBe(false);

    const expanded = deriveMessagesTimelineRows({ ...base, expandedRunIds: new Set(folds) });
    const groups = expanded.filter((row) => row.kind === "work-toggle");
    expect(groups.length).toBe(5);
    for (const group of groups) {
      expect(group.kind === "work-toggle" && group.hiddenCount).toBeGreaterThan(1);
    }
    // No tool call renders as its own ungrouped row.
    expect(
      expanded.filter((row) => row.kind === "work" && row.groupedEntries[0]?.tone === "tool"),
    ).toEqual([]);
  });
});
