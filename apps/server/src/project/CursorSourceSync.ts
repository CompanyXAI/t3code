import {
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { runCursorAgentsRefresh } from "../cursorAgents/CursorAgentsRefresh.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { cursorIdeGlobalStateDb, cursorIdeWorkspaceStorageDir } from "./CursorAgentSessionPaths.ts";
import {
  discoverCursorTranscripts,
  type CursorTranscriptCandidate,
} from "./CursorTranscriptDiscovery.ts";

/**
 * A running Cursor IDE writes its global state db (and WAL) every few seconds,
 * so the fingerprint is almost never stable. Changes are picked up at most once
 * per MIN_RESCAN_MS; with no change a full pass still runs every
 * FULL_RESCAN_MS as a safety net.
 */
const MIN_RESCAN_MS = 60_000;
const FULL_RESCAN_MS = 10 * 60_000;
/** The IDE composer index (15+ GB db on busy machines) is rebuilt at most this often. */
const IDE_INDEX_MAX_AGE_MS = 5 * 60_000;
const DISCOVERY_OPERATION_BUDGET = 20_000;

export interface CursorSourceSnapshot {
  readonly transcripts: ReadonlyArray<CursorTranscriptCandidate>;
  readonly truncated: boolean;
}

interface CacheEntry {
  readonly snapshot: CursorSourceSnapshot;
  readonly fingerprint: string;
  readonly refreshedAt: number;
}

/**
 * One background pass over Cursor sources. Session scans and the agents page
 * read `peek` / the cloud index and never start this work themselves.
 */
export class CursorSourceSync extends Context.Service<
  CursorSourceSync,
  {
    readonly peek: (homePath: string) => CursorSourceSnapshot | undefined;
  }
>()("t3/project/CursorSourceSync") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  const scheduler = yield* Scheduler.Scheduler;
  const cache = new Map<string, CacheEntry>();
  const deps = { path, fileSystem, platform, environment, homeDir };

  const stamp = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((stats) => {
        const mtime = Option.getOrNull(stats.mtime)?.getTime() ?? 0;
        return `${mtime}:${stats.size}`;
      }),
      Effect.orElseSucceed(() => "missing"),
    );

  const fingerprintOf = (homePath: string) =>
    Effect.gen(function* () {
      const workspaceStorage = cursorIdeWorkspaceStorageDir(path, platform, environment, homeDir);
      const globalDb = cursorIdeGlobalStateDb(path, workspaceStorage);
      const parts = yield* Effect.all(
        [
          stamp(globalDb),
          stamp(`${globalDb}-wal`),
          stamp(homePath),
          stamp(path.join(homePath, "projects")),
          stamp(path.join(homePath, "chats")),
        ],
        { concurrency: "unbounded" },
      );
      return parts.join("\0");
    });

  const tick = Effect.fn("CursorSourceSync.tick")(function* () {
    yield* runCursorAgentsRefresh().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cursor cloud index refresh failed", { cause }),
      ),
    );
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return;
    const cursorDriver = ProviderDriverKind.make("cursor");
    const cursorInstances = Object.entries(settings.providerInstances).filter(
      ([, instance]) =>
        instance.driver === cursorDriver && resolveProviderInstanceEnabled(instance),
    );
    const implicitCursor =
      cursorInstances.length === 0 &&
      !Object.hasOwn(settings.providerInstances, "cursor") &&
      resolveProviderInstanceEnabled({ driver: cursorDriver });
    if (cursorInstances.length === 0 && !implicitCursor) return;
    const providerInstanceId = ProviderInstanceId.make(cursorInstances[0]?.[0] ?? "cursor");
    // Transcripts live under ~/.cursor, not a custom CLI homePath.
    const homePath = path.resolve(path.join(homeDir, ".cursor"));
    const fingerprint = yield* fingerprintOf(homePath);
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const existing = cache.get(homePath);
    if (existing !== undefined) {
      const age = now - existing.refreshedAt;
      if (age < MIN_RESCAN_MS) return;
      if (existing.fingerprint === fingerprint && age < FULL_RESCAN_MS) return;
    }
    const discovered = yield* discoverCursorTranscripts(
      deps,
      homePath,
      providerInstanceId,
      DISCOVERY_OPERATION_BUDGET,
      IDE_INDEX_MAX_AGE_MS,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cursor source sync failed", { cause }).pipe(
          Effect.as({ transcripts: existing?.snapshot.transcripts ?? [], truncated: true }),
        ),
      ),
    );
    cache.set(homePath, {
      snapshot: discovered,
      fingerprint,
      refreshedAt: now,
    });
  });

  yield* scheduler.register("cursor-source-sync", tick());

  return CursorSourceSync.of({
    peek: (homePath) => cache.get(path.resolve(homePath))?.snapshot,
  });
});

export const layer = Layer.effect(CursorSourceSync, make);
