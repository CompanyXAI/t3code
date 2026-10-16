import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { createTranscriptJsonReader, createTranscriptJsonSelector } from "./AgentSessionJson.ts";

const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});
const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  message: Schema.optional(TranscriptMessage),
});

describe("Cursor selective transcript read", () => {
  it("keeps top-level role through the shared JSON selector", () => {
    const select = createTranscriptJsonSelector(TranscriptRecord);
    expect(select(["role"])).toBe(true);
    expect(select(["message"])).toBe(true);
    const line = JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "Import me" }] },
    });
    const reader = createTranscriptJsonReader(() => undefined, select);
    reader.write(line);
    expect(reader.finish()).toEqual({
      role: "user",
      message: { content: [{ type: "text", text: "Import me" }] },
    });
  });
});
