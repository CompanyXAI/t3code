// @effect-diagnostics nodeBuiltinImport:off - posix join for platform-independent expectations.
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Path from "effect/Path";

import {
  buildCursorSlugIndex,
  cursorIdeWorkspaceStorageDir,
  cursorProjectSlug,
  parseCursorWorkspaceFolder,
} from "./CursorAgentSessionPaths.ts";

describe("cursorProjectSlug", () => {
  it("matches the folder names Cursor writes under ~/.cursor/projects", () => {
    expect(cursorProjectSlug("c:\\Users\\me\\Desktop\\.cursor")).toBe("c-Users-me-Desktop-cursor");
    expect(
      cursorProjectSlug("C:\\Users\\me\\Desktop\\Terminal\\includes\\trading-app\\backend\\python"),
    ).toBe("C-Users-me-Desktop-Terminal-includes-trading-app-backend-python");
    expect(cursorProjectSlug("/home/me/my  repo/")).toBe("home-me-my-repo");
  });
});

describe("parseCursorWorkspaceFolder", () => {
  it("reads local file folders only", () => {
    const folder = parseCursorWorkspaceFolder(
      JSON.stringify({ folder: "file:///home/me/proj%20a" }),
    );
    expect(folder === null ? null : cursorProjectSlug(folder)).toBe("home-me-proj-a");
    expect(
      parseCursorWorkspaceFolder(
        JSON.stringify({ folder: "file:///c%3A/Users/me/Desktop/.cursor" }),
      ),
    ).toBe("c:\\Users\\me\\Desktop\\.cursor");
    expect(
      parseCursorWorkspaceFolder(JSON.stringify({ folder: "vscode-remote://ssh/x" })),
    ).toBeNull();
    expect(
      parseCursorWorkspaceFolder(JSON.stringify({ workspace: "file:///a.code-workspace" })),
    ).toBeNull();
    expect(parseCursorWorkspaceFolder("not json")).toBeNull();
  });
});

describe("buildCursorSlugIndex", () => {
  it("binds a slug only when exactly one distinct folder produces it", () => {
    const index = buildCursorSlugIndex(["/a/b-c", "/a/b-c", "/a/b.c", "/x/y"]);
    expect(index.get("a-b-c")).toBeNull();
    expect(index.get("x-y")).toBe("/x/y");
    expect(index.get("missing")).toBeUndefined();
  });
});

describe("cursorIdeWorkspaceStorageDir", () => {
  const path = { ...Path.Path.of(NodePath as never), join: NodePath.posix.join } as Path.Path;
  it("follows the VS Code user-data layout per platform", () => {
    expect(cursorIdeWorkspaceStorageDir(path, "win32", { APPDATA: "/r" }, "/h")).toBe(
      "/r/Cursor/User/workspaceStorage",
    );
    expect(cursorIdeWorkspaceStorageDir(path, "darwin", {}, "/h")).toBe(
      "/h/Library/Application Support/Cursor/User/workspaceStorage",
    );
    expect(cursorIdeWorkspaceStorageDir(path, "linux", {}, "/h")).toBe(
      "/h/.config/Cursor/User/workspaceStorage",
    );
  });
});
