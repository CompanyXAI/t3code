// @effect-diagnostics nodeBuiltinImport:off - plain Promise storage shared by every connection.
/**
 * Persistent index of one Cursor account's cloud and self-hosted agents.
 *
 * Cursor lists agents newest change first, 20 to 100 per page, and a full
 * listing of a large account takes about a minute. The index therefore lists
 * everything once, keeps that snapshot on disk, and afterwards only fetches
 * the pages that changed since the last sync (usually one). A full sync runs
 * again once a day to drop deleted or archived agents, or when the key now
 * belongs to a different Cursor account.
 *
 * @module server/cursorAgents/CursorAgentIndex
 */
import * as FS from "node:fs/promises";
import * as NodePath from "node:path";
import type { CursorDirectoryEntry } from "@t3tools/provider-cursor/server/CursorAgentDirectory";

export interface CursorIndexSnapshot {
  readonly version: 1;
  readonly accountId: string;
  /** Email that owned the key at the last sync; a different one forces a full sync. */
  readonly email: string | null;
  readonly entries: ReadonlyArray<CursorDirectoryEntry>;
  /** Newest `updatedAt` seen; the next delta starts a little before it. */
  readonly highWater: number;
  readonly fullSyncAt: number;
  readonly syncedAt: number;
}

export interface CursorIndexStorage {
  readonly load: (accountId: string) => Promise<CursorIndexSnapshot | undefined>;
  readonly save: (snapshot: CursorIndexSnapshot) => Promise<void>;
}

/** What one sync needs from Cursor, bound to one account's own key. */
export interface CursorIndexSync {
  /** Cloud agents newest first; with `since`, stops once older agents are reached. */
  readonly listCloud: (since: number | undefined) => Promise<{
    readonly entries: ReadonlyArray<CursorDirectoryEntry>;
    readonly complete: boolean;
  }>;
  readonly statuses: (
    agentIds: ReadonlyArray<string> | "all",
  ) => Promise<ReadonlyMap<string, CursorDirectoryEntry["status"]>>;
  readonly email: () => Promise<string | null>;
}

/** While the page is open, a delta runs at most this often. */
export const DELTA_EVERY_MS = 20_000;
/** A full sync drops deleted and archived agents. */
export const FULL_EVERY_MS = 24 * 60 * 60 * 1000;
/** A delta re-reads a little before the newest known change. */
export const DELTA_MARGIN_MS = 10 * 60 * 1000;
const MAX_STATUS_LOOKUPS = 40;

export const memoryStorage = (): CursorIndexStorage => {
  const snapshots = new Map<string, CursorIndexSnapshot>();
  return {
    load: async (accountId) => snapshots.get(accountId),
    save: async (snapshot) => {
      snapshots.set(snapshot.accountId, snapshot);
    },
  };
};

/** One JSON file per account. Holds agent names and summaries, never keys. */
export const fileStorage = (dir: string): CursorIndexStorage => {
  const fileOf = (accountId: string) =>
    NodePath.join(dir, `${accountId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  return {
    load: (accountId) =>
      FS.readFile(fileOf(accountId), "utf8").then(
        (text) => {
          const parsed = JSON.parse(text) as Partial<CursorIndexSnapshot> | null;
          return parsed?.version === 1 &&
            parsed.accountId === accountId &&
            Array.isArray(parsed.entries)
            ? (parsed as CursorIndexSnapshot)
            : undefined;
        },
        () => undefined,
      ),
    save: async (snapshot) => {
      await FS.mkdir(dir, { recursive: true });
      const file = fileOf(snapshot.accountId);
      const temp = `${file}.${process.pid}.tmp`;
      await FS.writeFile(temp, JSON.stringify(snapshot));
      await FS.rename(temp, file);
    },
  };
};

const withStatus = (
  entry: CursorDirectoryEntry,
  status: CursorDirectoryEntry["status"] | undefined,
): CursorDirectoryEntry =>
  status === undefined || status === "unknown" || entry.status !== "unknown"
    ? entry
    : { ...entry, status };

const newest = (entries: ReadonlyArray<CursorDirectoryEntry>, floor: number) =>
  entries.reduce((max, entry) => Math.max(max, entry.updatedAt), floor);

/** One sync step: a full listing on first run, daily or after an account change, else a delta. */
export async function syncSnapshot(
  accountId: string,
  previous: CursorIndexSnapshot | undefined,
  sync: CursorIndexSync,
  now: number,
): Promise<CursorIndexSnapshot> {
  const email = await sync.email().catch(() => previous?.email ?? null);
  const accountChanged =
    previous !== undefined && email !== null && previous.email !== null && email !== previous.email;
  if (previous === undefined || accountChanged || now - previous.fullSyncAt > FULL_EVERY_MS) {
    const [listed, statuses] = await Promise.all([
      sync.listCloud(undefined),
      sync.statuses("all").catch(() => new Map<string, CursorDirectoryEntry["status"]>()),
    ]);
    const entries = listed.entries
      .map((entry) => withStatus(entry, statuses.get(entry.agentId)))
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
    return {
      version: 1,
      accountId,
      email,
      entries,
      highWater: newest(entries, 0),
      fullSyncAt: now,
      syncedAt: now,
    };
  }
  const listed = await sync.listCloud(previous.highWater - DELTA_MARGIN_MS);
  const byId = new Map(previous.entries.map((entry) => [entry.agentId, entry] as const));
  // Changed agents plus the ones still running: a finished run does not
  // always move an agent up the list, so its status is asked directly.
  const recheck = new Set(listed.entries.map((entry) => entry.agentId));
  for (const entry of previous.entries) if (entry.status === "running") recheck.add(entry.agentId);
  const statuses = await sync
    .statuses([...recheck].slice(0, MAX_STATUS_LOOKUPS))
    .catch(() => new Map<string, CursorDirectoryEntry["status"]>());
  for (const entry of listed.entries) {
    byId.set(
      entry.agentId,
      withStatus(entry, statuses.get(entry.agentId) ?? byId.get(entry.agentId)?.status),
    );
  }
  for (const [agentId, status] of statuses) {
    const entry = byId.get(agentId);
    if (entry !== undefined && status !== "unknown") byId.set(agentId, { ...entry, status });
  }
  const entries = [...byId.values()].toSorted((a, b) => b.updatedAt - a.updatedAt);
  return {
    ...previous,
    email: email ?? previous.email,
    entries,
    highWater: newest(entries, previous.highWater),
    syncedAt: now,
  };
}

export interface CursorIndexState {
  readonly snapshot: CursorIndexSnapshot | undefined;
  readonly syncing: boolean;
  /** Why the last sync failed; the last good snapshot is still served. */
  readonly error: string | undefined;
}

interface Slot {
  snapshot: CursorIndexSnapshot | undefined;
  loading: Promise<void> | undefined;
  loaded: boolean;
  inFlight: Promise<void> | undefined;
  error: string | undefined;
  stale: boolean;
}

const describe = (error: unknown) =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

/**
 * All snapshots of one T3 server. At most one sync per account runs at a
 * time; callers get the stored snapshot right away and a sync starts in the
 * background when the snapshot is older than DELTA_EVERY_MS or marked stale.
 */
export class CursorAgentIndex {
  private readonly slots = new Map<string, Slot>();
  private readonly storage: CursorIndexStorage;
  private readonly now: () => number;

  constructor(
    storage: CursorIndexStorage,
    // @effect-diagnostics-next-line globalDate:off -- wall clock for snapshot ages.
    now: () => number = () => Date.now(),
  ) {
    this.storage = storage;
    this.now = now;
  }

  private slotOf(accountId: string): Slot {
    let slot = this.slots.get(accountId);
    if (slot === undefined) {
      slot = {
        snapshot: undefined,
        loading: undefined,
        loaded: false,
        inFlight: undefined,
        error: undefined,
        stale: false,
      };
      this.slots.set(accountId, slot);
    }
    return slot;
  }

  /** Waits up to `waitMs` only when there is no snapshot yet (first sync). */
  async read(accountId: string, sync: CursorIndexSync, waitMs: number): Promise<CursorIndexState> {
    const slot = this.slotOf(accountId);
    if (!slot.loaded) {
      slot.loading ??= this.storage.load(accountId).then(
        (snapshot) => {
          slot.snapshot ??= snapshot;
          slot.loaded = true;
        },
        () => {
          slot.loaded = true;
        },
      );
      await slot.loading;
    }
    const due =
      slot.snapshot === undefined ||
      slot.stale ||
      this.now() - slot.snapshot.syncedAt > DELTA_EVERY_MS;
    if (due) this.start(accountId, slot, sync);
    if (slot.snapshot === undefined && slot.inFlight !== undefined && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        slot.inFlight,
        new Promise<void>((resolve) => {
          // @effect-diagnostics-next-line globalTimers:off -- bounded wait inside a Promise helper.
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    return { snapshot: slot.snapshot, syncing: slot.inFlight !== undefined, error: slot.error };
  }

  /** After a launch or stop: the next read runs a delta right away. */
  markStale(accountId: string): void {
    this.slotOf(accountId).stale = true;
  }

  private start(accountId: string, slot: Slot, sync: CursorIndexSync): void {
    if (slot.inFlight !== undefined) return;
    slot.stale = false;
    slot.inFlight = syncSnapshot(accountId, slot.snapshot, sync, this.now())
      .then(async (next) => {
        slot.snapshot = next;
        slot.error = undefined;
        await this.storage.save(next).catch(() => undefined);
      })
      .catch((error: unknown) => {
        slot.error = describe(error);
      })
      .finally(() => {
        slot.inFlight = undefined;
      });
  }
}
