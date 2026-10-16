import { assert, describe, it } from "@effect/vitest";
import type { CursorDirectoryEntry } from "@t3tools/provider-cursor/server/CursorAgentDirectory";
import * as Effect from "effect/Effect";

import {
  CursorAgentIndex,
  DELTA_EVERY_MS,
  FULL_EVERY_MS,
  memoryStorage,
  syncSnapshot,
  type CursorIndexSync,
} from "./CursorAgentIndex.ts";

const entry = (
  agentId: string,
  updatedAt: number,
  status: CursorDirectoryEntry["status"] = "unknown",
): CursorDirectoryEntry => ({
  agentId,
  accountId: "a1",
  runtime: "cloud",
  runtimeLabel: "Cloud",
  environmentName: undefined,
  name: agentId,
  summary: "",
  status,
  repos: [],
  cwd: undefined,
  createdByT3: false,
  archived: false,
  updatedAt,
});

const fakeSync = (options: {
  readonly cloud: ReadonlyArray<CursorDirectoryEntry>;
  readonly statuses?: Record<string, CursorDirectoryEntry["status"]>;
  readonly email?: string | null;
}) => {
  const calls: Array<{ since: number | undefined } | { statuses: ReadonlyArray<string> | "all" }> =
    [];
  const sync: CursorIndexSync = {
    listCloud: async (since) => {
      calls.push({ since });
      return {
        entries:
          since === undefined
            ? options.cloud
            : options.cloud.filter((item) => item.updatedAt >= since),
        complete: since === undefined,
      };
    },
    statuses: async (agentIds) => {
      calls.push({ statuses: agentIds });
      return new Map(
        Object.entries(options.statuses ?? {}).filter(
          ([id]) => agentIds === "all" || agentIds.includes(id),
        ),
      );
    },
    email: async () => options.email ?? "me@example.com",
  };
  return { sync, calls };
};

describe("CursorAgentIndex", () => {
  it.effect("lists everything once, then only the changed pages", () =>
    Effect.promise(async () => {
      const day0 = 1_000_000_000_000;
      const first = fakeSync({
        cloud: [entry("bc-old", day0 - 3_600_000), entry("bc-run", day0 - 60_000)],
        statuses: { "bc-old": "finished", "bc-run": "running" },
      });
      const full = await syncSnapshot("a1", undefined, first.sync, day0);
      assert.deepStrictEqual(first.calls, [{ since: undefined }, { statuses: "all" }]);
      assert.deepStrictEqual(
        full.entries.map((item) => [item.agentId, item.status]),
        [
          ["bc-run", "running"],
          ["bc-old", "finished"],
        ],
      );

      const later = fakeSync({
        cloud: [
          entry("bc-new", day0 + 5_000),
          entry("bc-run", day0 - 60_000),
          entry("bc-old", day0 - 3_600_000),
        ],
        statuses: { "bc-new": "running", "bc-run": "finished" },
      });
      const delta = await syncSnapshot("a1", full, later.sync, day0 + 30_000);
      const since = (later.calls[0] as { since: number }).since;
      assert.isTrue(since < day0 && since > day0 - 3_600_000);
      assert.deepStrictEqual(
        delta.entries.map((item) => [item.agentId, item.status]),
        [
          ["bc-new", "running"],
          ["bc-run", "finished"],
          ["bc-old", "finished"],
        ],
      );
      assert.strictEqual(delta.fullSyncAt, day0);
    }),
  );

  it.effect("runs a full sync daily and when the key belongs to another account", () =>
    Effect.promise(async () => {
      const day0 = 1_000_000_000_000;
      const base = await syncSnapshot("a1", undefined, fakeSync({ cloud: [] }).sync, day0);
      const daily = fakeSync({ cloud: [] });
      await syncSnapshot("a1", base, daily.sync, day0 + FULL_EVERY_MS + 1);
      assert.deepStrictEqual(daily.calls[0], { since: undefined });
      const other = fakeSync({ cloud: [], email: "someone-else@example.com" });
      await syncSnapshot("a1", base, other.sync, day0 + 1_000);
      assert.deepStrictEqual(other.calls[0], { since: undefined });
    }),
  );

  it.effect("serves the stored snapshot and shares one sync per account", () =>
    Effect.promise(async () => {
      let clock = 1_000_000_000_000;
      const index = new CursorAgentIndex(memoryStorage(), () => clock);
      const { sync, calls } = fakeSync({ cloud: [entry("bc-1", clock - 1)] });
      const [one, two] = await Promise.all([
        index.read("a1", sync, 1_000),
        index.read("a1", sync, 1_000),
      ]);
      assert.strictEqual(one.snapshot?.entries.length, 1);
      assert.strictEqual(two.snapshot?.entries.length, 1);
      assert.strictEqual(calls.filter((call) => "since" in call).length, 1);

      await index.read("a1", sync, 0);
      assert.strictEqual(calls.filter((call) => "since" in call).length, 1);

      clock += DELTA_EVERY_MS + 1;
      const stale = await index.read("a1", sync, 0);
      assert.isTrue(stale.syncing);
      assert.strictEqual(stale.snapshot?.entries.length, 1);
    }),
  );
});
