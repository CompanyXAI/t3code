// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";

import {
  buildCursorIdeIndex,
  cursorIdeComposerLabels,
  cursorIdeComposerPath,
  cursorIdePathEvidenceFolder,
  cursorIdeRootComposer,
  loadCursorIdeIndex,
  parseCursorIdeComposerPath,
} from "./CursorIdeIndex.ts";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: null,
  wid: null,
  createdAt: 1,
  updatedAt: 2,
  isDraft: 0,
  isSub: 0,
  draftText: null,
  subs: null,
  ...extra,
});

describe("CursorIdeIndex", () => {
  it("labels archived, active, unlisted, draft and subagent composers", () => {
    const index = buildCursorIdeIndex(
      [
        row("parent", { subs: JSON.stringify(["child"]), wid: "ws1" }),
        row("child", { isSub: 1 }),
        row("draft", { isDraft: 1, draftText: "unsent" }),
        row("archived", { wid: "ws1" }),
      ],
      [
        ["parent", "ws1", false],
        ["archived", "ws1", true],
      ],
    );
    expect(cursorIdeComposerLabels(index, "parent")).toEqual(["IDE", "active"]);
    expect(cursorIdeComposerLabels(index, "archived")).toEqual(["IDE", "archived"]);
    expect(cursorIdeComposerLabels(index, "draft")).toEqual([
      "IDE",
      "not in any workspace list",
      "draft",
    ]);
    expect(cursorIdeComposerLabels(index, "child")).toContain("subagent");
    expect(index.parentOf.get("child")).toBe("parent");
    expect(index.composers.get("draft")?.draftText).toBe("unsent");
  });

  it("drops a subagent link claimed by two parents", () => {
    const index = buildCursorIdeIndex(
      [row("a", { subs: JSON.stringify(["c"]) }), row("b", { subs: JSON.stringify(["c"]) })],
      [],
    );
    expect(index.parentOf.has("c")).toBe(false);
  });

  it("round-trips the virtual composer path", () => {
    const p = cursorIdeComposerPath("C:\\x\\state.vscdb", "abc");
    expect(parseCursorIdeComposerPath(p)).toEqual({
      globalDb: "C:\\x\\state.vscdb",
      composerId: "abc",
    });
    expect(parseCursorIdeComposerPath("C:\\x\\a.jsonl")).toBeNull();
  });
});

describe("cursorIdePathEvidenceFolder", () => {
  const folders = [
    { key: "c:/dev/app", folder: "C:\\dev\\app" },
    { key: "c:/dev/app/pkg", folder: "C:\\dev\\app\\pkg" },
    { key: "c:/dev/other", folder: "C:\\dev\\other" },
  ];
  const bubbles: Record<string, string> = {
    b1: JSON.stringify({
      toolFormerData: { params: JSON.stringify({ path: "C:\\dev\\app\\pkg\\a.ts" }) },
    }),
    b2: JSON.stringify({ relevantFiles: ["file:///c%3A/dev/app/pkg/b.ts"] }),
  };
  const read = (id: string) => bubbles[id] ?? null;
  const headers = [{ bubbleId: "b1" }, { bubbleId: "b2" }];

  it("assigns the one deepest folder all known paths lie under", () => {
    expect(
      cursorIdePathEvidenceFolder({ fullConversationHeadersOnly: headers }, read, folders, true),
    ).toBe("C:\\dev\\app\\pkg");
  });

  it("proves nothing when paths span folders or lie outside all of them", () => {
    expect(
      cursorIdePathEvidenceFolder(
        { fullConversationHeadersOnly: headers, newlyCreatedFiles: ["C:\\dev\\other\\x.ts"] },
        read,
        folders,
        true,
      ),
    ).toBeNull();
    expect(
      cursorIdePathEvidenceFolder({ context: { f: "D:\\elsewhere\\x.ts" } }, read, folders, true),
    ).toBeNull();
  });

  it("labels path-assigned chats and follows nested subagents to their root", () => {
    const index = buildCursorIdeIndex(
      [
        row("top", { subs: JSON.stringify(["mid"]) }),
        row("mid", { isSub: 1, subs: JSON.stringify(["leaf"]) }),
        row("leaf", { isSub: 1 }),
        row("loose"),
      ],
      [],
      [["loose", "C:\\dev\\app"]],
    );
    expect(cursorIdeComposerLabels(index, "loose")).toContain("from file paths");
    expect(cursorIdeRootComposer(index, "leaf")).toBe("top");
    expect(cursorIdeRootComposer(index, "top")).toBeNull();
  });

  it("listing the IDE index does not read bubble rows", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cursor-ide-index-"));
    const workspaceStorage = NodePath.join(root, "User", "workspaceStorage");
    const workspaceId = "ws1";
    const folder = NodePath.join(root, "project");
    NodeFS.mkdirSync(NodePath.join(workspaceStorage, workspaceId), { recursive: true });
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(workspaceStorage, workspaceId, "workspace.json"),
      JSON.stringify({ folder: `file://${folder}` }),
    );
    const globalDb = NodePath.join(root, "User", "globalStorage", "state.vscdb");
    NodeFS.mkdirSync(NodePath.dirname(globalDb), { recursive: true });
    const db = new NodeSqlite.DatabaseSync(globalDb);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
    const composer = {
      name: "Loose",
      fullConversationHeadersOnly: [{ bubbleId: "b1" }],
    };
    const bubble = { relevantFiles: [`file://${folder}/src/main.ts`] };
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run("composerData:loose", JSON.stringify(composer));
    insert.run("bubbleId:loose:b1", JSON.stringify(bubble));
    db.close();

    const listed = await loadCursorIdeIndex(globalDb, workspaceStorage, 10_000, false);
    expect(listed?.composers.has("loose")).toBe(true);
    expect(listed?.pathFolderOf.size).toBe(0);

    const withEvidence = await loadCursorIdeIndex(globalDb, workspaceStorage, 10_000, true);
    expect(withEvidence?.pathFolderOf.get("loose")).toBe(folder);
  });
});
