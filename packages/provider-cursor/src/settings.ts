import { CustomModelSetting, makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Keep V1's CLI configuration when V2 rewrites the shared settings file.
    // V2's Cursor SDK does not use these fields.
    binaryPath: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiEndpoint: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Opt-in: installs T3's hook in ~/.cursor/hooks.json so shell commands,
    // MCP calls and file edits wait for approval in T3 (approval-required mode).
    approvalHooks: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Approval hooks",
        description:
          "Install T3's hook in ~/.cursor/hooks.json so commands and file edits wait for approval in T3.",
      }),
    ),
    // Absent means "use the legacy server-wide flag" so existing installs keep working.
    keychainUsageEnabled: Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({
        title: "Cursor account usage",
        description:
          "Read this account's Cursor CLI login from the macOS Keychain to show history and monthly limits.",
      }),
    ),
    defaultRunsOn: Schema.Literals(["local", "worker", "cloud"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("local" as const)),
      Schema.annotateKey({
        title: "Runs on",
        description: "Where new agents for this account run when a chat has not chosen.",
      }),
    ),
    // This instance's Cursor config folder, like Claude's CLAUDE_CONFIG_DIR and
    // Codex's CODEX_HOME. Empty is the machine's standard Cursor login.
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Cursor home path (unofficial)",
        description:
          "Custom Cursor config folder for this account's CLI login (APPDATA on Windows, XDG_CONFIG_HOME elsewhere). Empty uses the standard login.",
        providerSettingsForm: { placeholder: "standard login", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [],
  },
);
export type CursorSettings = typeof CursorSettings.Type;
