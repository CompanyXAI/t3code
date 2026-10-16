import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import {
  buildCursorSlugIndex,
  cursorIdeGlobalStateDb,
  cursorIdeWorkspaceStorageDir,
  parseCursorWorkspaceFolder,
  readCursorChatCwdIndex,
} from "./CursorAgentSessionPaths.ts";
import {
  cursorIdeComposerLabels,
  cursorIdeComposerPath,
  loadCursorIdeIndex,
} from "./CursorIdeIndex.ts";
import { isT3CursorSdkAgent, readCursorSdkAgent } from "./CursorStoreDb.ts";

/**
 * Cursor transcript discovery (IDE index, CLI store.db, SDK index.db, JSONL).
 * The session scanner calls this the same way it calls Claude and Codex
 * discovery. Production reads a cache filled by CursorSourceSync instead.
 */
export interface CursorTranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly size: number;
  readonly cwd?: string;
  readonly orphanSessionId?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly labels?: ReadonlyArray<string>;
}

export interface CursorTranscriptDiscoveryDeps {
  readonly path: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

export const discoverCursorTranscripts = Effect.fn("discoverCursorTranscripts")(function* (
  deps: CursorTranscriptDiscoveryDeps,
  homePath: string,
  providerInstanceId: ProviderInstanceId,
  operationBudget: number,
  /** Reuse an IDE index built within this window even if the db changed since. */
  ideIndexMaxAgeMs = 0,
) {
  const listDirectory = (directory: string) =>
    deps.fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const statOption = (target: string) =>
    deps.fileSystem.stat(target).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
  const projectsDir = deps.path.join(homePath, "projects");
  let operationsRemaining = operationBudget;
  let truncated = false;
  const readDirectory = (directory: string) => {
    if (operationsRemaining <= 0) {
      truncated = true;
      return Effect.succeed<ReadonlyArray<string>>([]);
    }
    operationsRemaining -= 1;
    return listDirectory(directory);
  };
  const projectDirectories = yield* readDirectory(projectsDir);
  const transcripts: Array<CursorTranscriptCandidate> = [];
  // cwd comes only from ~/.cursor/chats/<md5(cwd)>/<agentId>/meta.json; the
  // project folder name (slug or numeric window id) is never decoded.
  const chatCwdByAgentId = yield* readCursorChatCwdIndex(
    deps.path.join(homePath, "chats"),
    deps.path,
    readDirectory,
    (filePath) => deps.fileSystem.readFileString(filePath).pipe(Effect.option),
  );

  // Folders Cursor itself recorded; transcripts are bound to one only when
  // Cursor's slug of exactly one of them equals the project folder name.
  const recordedFolders: Array<string> = [];
  for (const entry of chatCwdByAgentId.values())
    if (entry.cwd !== null) recordedFolders.push(entry.cwd);
  const workspaceStorage = cursorIdeWorkspaceStorageDir(
    deps.path,
    deps.platform,
    deps.environment,
    deps.homeDir,
  );
  const folderByWorkspaceId = new Map<string, string>();
  for (const workspaceId of yield* readDirectory(workspaceStorage)) {
    const body = yield* deps.fileSystem
      .readFileString(deps.path.join(workspaceStorage, workspaceId, "workspace.json"))
      .pipe(Effect.option);
    const folder = Option.isSome(body) ? parseCursorWorkspaceFolder(body.value) : null;
    if (folder !== null) {
      recordedFolders.push(folder);
      folderByWorkspaceId.set(workspaceId, folder);
    }
  }

  // Local SDK agents: ~/.cursor/projects/<any>/sdk-agent-store/<sha256(cwd)>/index.db
  // lists agents with workspace_ref (the cwd) and their checkpoint stores. SDK ids are
  // `agent-<uuid>`; the bare uuid is skipped below so chats/JSONL copies don't duplicate.
  const sdkUuids = new Set<string>();
  // Every SDK agent id as written (`agent-<uuid>`), T3-created ones included: their
  // agent-transcripts JSONL copies are never imported as IDE chats.
  const sdkAgentIds = new Set<string>();
  for (const projectDirectory of projectDirectories) {
    const storeParent = deps.path.join(projectsDir, projectDirectory, "sdk-agent-store");
    for (const storeHash of yield* readDirectory(storeParent)) {
      const storeRoot = deps.path.join(storeParent, storeHash);
      const agents = yield* Effect.tryPromise(() => readCursorSdkAgent(storeRoot, null)).pipe(
        Effect.orElseSucceed(() => []),
      );
      for (const agent of agents) {
        if (agent.cwd) recordedFolders.push(agent.cwd);
        sdkAgentIds.add(agent.agentId);
        if (isT3CursorSdkAgent(agent)) continue;
        const storePath = deps.path.join(storeRoot, "agents", agent.agentDir, "store.db");
        const stats = yield* statOption(storePath);
        if (Option.isNone(stats) || Option.isNone(stats.value.mtime)) continue;
        sdkUuids.add(agent.agentId.replace(/^agent-/, ""));
        transcripts.push({
          filePath: storePath,
          mtimeMs: stats.value.mtime.value.getTime(),
          providerInstanceId,
          size: Number(stats.value.size),
          cwd: agent.cwd,
        });
      }
    }
  }
  // Chats with meta.json cwd and a store.db: decoded from the protobuf tree.
  const chatStoreIds = new Set<string>();
  for (const [agentId, entry] of chatCwdByAgentId) {
    if (sdkUuids.has(agentId)) continue;
    const storePath = deps.path.join(entry.chatDir, "store.db");
    const stats = yield* statOption(storePath);
    if (Option.isNone(stats) || Option.isNone(stats.value.mtime)) continue;
    chatStoreIds.add(agentId);
    transcripts.push({
      filePath: storePath,
      mtimeMs: stats.value.mtime.value.getTime(),
      providerInstanceId,
      size: Number(stats.value.size),
      ...(entry.cwd === null ? { orphanSessionId: agentId } : { cwd: entry.cwd }),
    });
  }

  const slugIndex = buildCursorSlugIndex(recordedFolders);
  for (const projectDirectory of projectDirectories) {
    const projectCwd = slugIndex.get(projectDirectory) ?? null;
    if (operationsRemaining <= 0) {
      truncated = true;
      break;
    }

    const transcriptsRoot = deps.path.join(projectsDir, projectDirectory, "agent-transcripts");
    // Layout: agent-transcripts/<session-id>/<session-id>.jsonl (sometimes nested one level).
    const sessionDirs = yield* readDirectory(transcriptsRoot);
    for (const sessionEntry of sessionDirs) {
      if (operationsRemaining <= 0) {
        truncated = true;
        break;
      }
      const sessionPath = deps.path.join(transcriptsRoot, sessionEntry);
      operationsRemaining -= 1;
      const sessionStats = yield* statOption(sessionPath);
      if (Option.isNone(sessionStats)) continue;

      const jsonlFiles: Array<string> = [];
      if (sessionStats.value.type === "File" && sessionEntry.endsWith(".jsonl")) {
        jsonlFiles.push(sessionPath);
      } else if (sessionStats.value.type === "Directory") {
        for (const entry of yield* readDirectory(sessionPath)) {
          if (entry.endsWith(".jsonl")) jsonlFiles.push(deps.path.join(sessionPath, entry));
        }
      }

      for (const filePath of jsonlFiles) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        const transcriptId = deps.path.basename(filePath, ".jsonl");
        // store.db / SDK copies of the same conversation win (tree order + tool calls).
        if (
          chatStoreIds.has(transcriptId) ||
          sdkUuids.has(transcriptId) ||
          sdkAgentIds.has(transcriptId)
        ) {
          continue;
        }
        const cwd = chatCwdByAgentId.get(transcriptId)?.cwd ?? projectCwd;
        operationsRemaining -= 1;
        const stats = yield* statOption(filePath);
        if (
          Option.isNone(stats) ||
          stats.value.type !== "File" ||
          Option.isNone(stats.value.mtime)
        ) {
          continue;
        }
        transcripts.push({
          filePath,
          mtimeMs: stats.value.mtime.value.getTime(),
          providerInstanceId,
          size: Number(stats.value.size),
          ...(cwd === null ? { orphanSessionId: transcriptId } : { cwd }),
          ...(cwd === null ? {} : { sessionId: transcriptId }),
        });
      }
    }
  }
  // Cursor copies one transcript id into several project folders (e.g. an
  // "empty-window" folder and the workspace it moved to). Keep one bound copy
  // per id (newest), and drop orphan copies of ids that are bound elsewhere.
  const boundById = new Map<string, CursorTranscriptCandidate>();
  for (const transcript of transcripts) {
    if (transcript.sessionId === undefined) continue;
    const existing = boundById.get(transcript.sessionId);
    if (existing === undefined || transcript.mtimeMs > existing.mtimeMs) {
      boundById.set(transcript.sessionId, transcript);
    }
  }
  const orphanIds = new Set<string>();
  const deduped = transcripts.filter((transcript) => {
    if (transcript.sessionId !== undefined) {
      return boundById.get(transcript.sessionId) === transcript;
    }
    if (transcript.orphanSessionId === undefined) return true;
    if (boundById.has(transcript.orphanSessionId) || orphanIds.has(transcript.orphanSessionId)) {
      return false;
    }
    orphanIds.add(transcript.orphanSessionId);
    return true;
  });
  // Every composer in the IDE global DB, labeled, nothing hidden (T3 as a Cursor debugger).
  const globalDb = cursorIdeGlobalStateDb(deps.path, workspaceStorage);
  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const ideIndex = yield* Effect.promise(() =>
    loadCursorIdeIndex(globalDb, workspaceStorage, 300_000, false, {
      now,
      maxAgeMs: ideIndexMaxAgeMs,
    }),
  );
  if (ideIndex === null) {
    return { transcripts: deduped, truncated };
  }
  const workspaceFolderOf = (composerId: string, depth = 0): string | null => {
    const entry = ideIndex.composers.get(composerId);
    if (entry === undefined) return null;
    const folder =
      entry.workspaceId === null ? undefined : folderByWorkspaceId.get(entry.workspaceId);
    if (folder !== undefined) return folder;
    // A subagent without its own workspace id runs in its (unique) parent's workspace.
    const parent = ideIndex.parentOf.get(composerId);
    if (parent !== undefined && depth <= 8) return workspaceFolderOf(parent, depth + 1);
    // Daniel's decision: a chat whose file paths all lie under one known folder is
    // assigned there, labeled "from file paths".
    return ideIndex.pathFolderOf.get(composerId) ?? null;
  };
  const labeled = deduped.map((transcript): CursorTranscriptCandidate => {
    const id = transcript.sessionId ?? transcript.orphanSessionId;
    const entry = id === undefined ? undefined : ideIndex.composers.get(id);
    if (id === undefined || entry === undefined) return transcript;
    // An orphan transcript is bound when its composer's workspace id proves the folder.
    const provenCwd = transcript.orphanSessionId === undefined ? null : workspaceFolderOf(id);
    const { orphanSessionId: _orphan, ...rest } = transcript;
    return {
      ...(provenCwd === null ? transcript : { ...rest, cwd: provenCwd, sessionId: id }),
      ...(entry.name === null ? {} : { title: entry.name }),
      labels: cursorIdeComposerLabels(ideIndex, id),
    };
  });
  const represented = new Set<string>([
    ...boundById.keys(),
    ...orphanIds,
    ...chatStoreIds,
    ...sdkUuids,
    ...[...sdkAgentIds].map((id) => id.replace(/^agent-/, "")),
  ]);
  for (const entry of ideIndex.composers.values()) {
    if (represented.has(entry.composerId)) continue;
    const cwd = workspaceFolderOf(entry.composerId);
    labeled.push({
      filePath: cursorIdeComposerPath(globalDb, entry.composerId),
      mtimeMs: entry.lastUpdatedAtMs ?? entry.createdAtMs ?? 0,
      providerInstanceId,
      size: 0,
      ...(cwd === null
        ? { orphanSessionId: entry.composerId }
        : { cwd, sessionId: entry.composerId }),
      ...(entry.name === null ? {} : { title: entry.name }),
      labels: cursorIdeComposerLabels(ideIndex, entry.composerId),
    });
  }
  return { transcripts: labeled, truncated };
});
