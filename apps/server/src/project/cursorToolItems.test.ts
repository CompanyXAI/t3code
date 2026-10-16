import { describe, expect, it } from "@effect/vitest";

import { cursorToolItem } from "./cursorToolItems.ts";

describe("cursorToolItem", () => {
  it("keeps the Read line range like Claude Read (offset/limit)", () => {
    expect(
      cursorToolItem(
        "read_file_v2",
        { targetFile: "a.ts", offset: 75, limit: 40, charsLimit: 1 },
        {},
      ),
    ).toMatchObject({ toolName: "Read", input: { file_path: "a.ts", offset: 75, limit: 40 } });
  });

  it("maps reads (store.db and IDE shapes) to Claude's Read", () => {
    expect(cursorToolItem("read", { path: "a.ts" }, { success: { content: "x" } })).toEqual({
      type: "dynamic_tool",
      toolName: "Read",
      input: { file_path: "a.ts" },
      output: "x",
    });
    expect(cursorToolItem("read_file_v2", { targetFile: "b.ts" }, { totalLinesInFile: 3 })).toEqual(
      {
        type: "dynamic_tool",
        toolName: "Read",
        input: { file_path: "b.ts" },
        output: { totalLinesInFile: 3 },
      },
    );
  });
  it("maps search tools to Grep/Glob with Claude field names", () => {
    expect(
      cursorToolItem("ripgrep_raw_search", { pattern: "foo", path: "src", glob: "*.ts" }, null),
    ).toEqual({
      type: "dynamic_tool",
      toolName: "Grep",
      input: { pattern: "foo", path: "src", glob: "*.ts" },
    });
    expect(
      cursorToolItem("glob_file_search", { globPattern: "**/*.md", targetDirectory: "d" }, null),
    ).toEqual({
      type: "dynamic_tool",
      toolName: "Glob",
      input: { pattern: "**/*.md", path: "d" },
    });
  });
  it("maps edits to file_change and web tools to web_search", () => {
    expect(cursorToolItem("edit_file_v2", { relativeWorkspacePath: "c.ts" }, {})).toEqual({
      type: "file_change",
      fileName: "c.ts",
    });
    expect(cursorToolItem("web_search", { searchTerm: "effect ts" }, {})).toEqual({
      type: "web_search",
      patterns: ["effect ts"],
    });
    expect(cursorToolItem("web_fetch", { url: "https://x.dev" }, {})).toEqual({
      type: "web_search",
      patterns: ["https://x.dev"],
    });
  });
  it("keeps unknown tools (e.g. MCP) as dynamic tools by name", () => {
    expect(cursorToolItem("mcp-srv-tool", { a: 1 }, { r: 2 })).toEqual({
      type: "dynamic_tool",
      toolName: "mcp-srv-tool",
      input: { a: 1 },
      output: { r: 2 },
    });
  });
});
