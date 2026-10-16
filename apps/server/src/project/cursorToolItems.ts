/**
 * Cursor tool calls (store.db proto names and IDE `toolFormerData` names) mapped
 * to the turn item kinds and field names the live Claude adapter emits
 * (`ClaudeAdapterV2` CLAUDE_KNOWN_TOOL_CLASSIFICATIONS), so imported Cursor
 * history renders like Claude tool rows instead of raw JSON.
 *
 * @module project/cursorToolItems
 */
type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
const firstString = (input: Rec, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
};

export type CursorToolItem =
  | {
      readonly type: "dynamic_tool";
      readonly toolName: string;
      readonly input: unknown;
      readonly output?: unknown;
    }
  | { readonly type: "file_change"; readonly fileName: string }
  | { readonly type: "web_search"; readonly patterns?: ReadonlyArray<string> };

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "targetFile",
  "target_file",
  "relativeWorkspacePath",
  "relative_workspace_path",
  "effectiveUri",
];
const DIR_KEYS = ["target_directory", "targetDirectory", "path", "directory"];

/** Read result text from store.db `success.content` or IDE `contents`/`content`. */
function readOutputText(output: unknown): string | undefined {
  const record = asRecord(output);
  return (
    firstString(asRecord(record.success), ["content"]) ??
    firstString(record, ["contents", "content"])
  );
}

export function cursorToolItem(name: string, input: unknown, output: unknown): CursorToolItem {
  const args = asRecord(input);
  const keep = output === null || output === undefined ? {} : { output };
  switch (name) {
    case "read":
    case "read_file":
    case "read_file_v2": {
      const filePath = firstString(args, PATH_KEYS);
      const text = readOutputText(output);
      return {
        type: "dynamic_tool",
        toolName: "Read",
        // Same input shape as Claude Read, so rows show the path and line range.
        input:
          filePath === undefined
            ? args
            : {
                file_path: filePath,
                ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
                ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
              },
        ...(text === undefined ? keep : { output: text }),
      };
    }
    case "grep":
    case "ripgrep_raw_search":
    case "grep_search": {
      const pattern = firstString(args, ["pattern", "query"]);
      const path = firstString(args, DIR_KEYS);
      const glob = firstString(args, ["glob", "glob_pattern", "globPattern", "include"]);
      return {
        type: "dynamic_tool",
        toolName: "Grep",
        input: {
          ...(pattern ? { pattern } : {}),
          ...(path ? { path } : {}),
          ...(glob ? { glob } : {}),
        },
        ...keep,
      };
    }
    case "glob":
    case "glob_file_search": {
      const pattern = firstString(args, ["glob_pattern", "globPattern", "pattern"]);
      const path = firstString(args, DIR_KEYS);
      return {
        type: "dynamic_tool",
        toolName: "Glob",
        input: { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) },
        ...keep,
      };
    }
    case "ls":
    case "list_dir": {
      const path = firstString(args, DIR_KEYS);
      return { type: "dynamic_tool", toolName: "LS", input: path ? { path } : args, ...keep };
    }
    case "edit":
    case "edit_file":
    case "edit_file_v2":
    case "write":
    case "delete":
    case "delete_file": {
      const fileName = firstString(args, PATH_KEYS);
      if (fileName !== undefined) return { type: "file_change", fileName };
      return { type: "dynamic_tool", toolName: name, input: args, ...keep };
    }
    case "web_search": {
      const term = firstString(args, ["search_term", "searchTerm", "query"]);
      return { type: "web_search", ...(term ? { patterns: [term] } : {}) };
    }
    case "web_fetch": {
      const url = firstString(args, ["url"]);
      return { type: "web_search", ...(url ? { patterns: [url] } : {}) };
    }
    case "update_todos":
    case "todo_write":
      return { type: "dynamic_tool", toolName: "TodoWrite", input: args, ...keep };
    case "task":
    case "task_v2":
      return { type: "dynamic_tool", toolName: "Task", input: args, ...keep };
    default:
      return { type: "dynamic_tool", toolName: name, input, ...keep };
  }
}
