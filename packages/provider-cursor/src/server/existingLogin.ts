// @effect-diagnostics nodeBuiltinImport:off -- path helpers for the machine Cursor home.
/**
 * Detect a Cursor login already on this computer that T3 can adopt.
 *
 * Two different credentials exist:
 * - SDK login (~/.cursor/sdk/auth.json via Cursor.auth.status): usable for
 *   the Agent SDK after a one-time import into T3 secret store.
 * - CLI / desktop login (auth.json under the standard Cursor home): powers
 *   the Cursor app, cursor-agent, and usage limits, but is not an Agent SDK
 *   API key. Surface it so the wizard is not a blank Not set up.
 *
 * @module provider-cursor/server/existingLogin
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { cursorLoginFile, standardCursorHomePath, type CursorPlatform } from "./CursorHome.ts";
import { Cursor } from "./sdk.ts";

export type CursorExistingLogin =
  | { readonly kind: "sdk"; readonly email?: string }
  | { readonly kind: "cli" }
  | { readonly kind: "none" };

export interface CursorExistingLoginProbe {
  readonly sdkStatus: () => Promise<{ status: string; email?: string }>;
  readonly cliAuthFileExists: (
    path: string,
  ) => Effect.Effect<boolean, never, FileSystem.FileSystem>;
}

const defaultProbe: CursorExistingLoginProbe = {
  sdkStatus: () => Cursor.auth.status(),
  cliAuthFileExists: (path) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.exists(path)),
      Effect.orElseSucceed(() => false),
    ),
};

/** Prefer an importable SDK login; otherwise note a CLI/desktop session. */
export const detectCursorExistingLogin = Effect.fn("detectCursorExistingLogin")(function* (
  environment: NodeJS.ProcessEnv = process.env,
  probe: CursorExistingLoginProbe = defaultProbe,
) {
  const sdk = yield* Effect.tryPromise({
    try: () => probe.sdkStatus(),
    catch: () => ({ _tag: "CursorSdkStatusError" as const }),
  }).pipe(Effect.option);

  if (sdk._tag === "Some" && sdk.value.status === "logged-in") {
    const email = sdk.value.email?.trim();
    return {
      kind: "sdk" as const,
      ...(email ? { email } : {}),
    } satisfies CursorExistingLogin;
  }

  const platform = (yield* HostProcess.Platform) as CursorPlatform;
  const home = yield* HostProcess.HomeDirectory;
  const loginFile = cursorLoginFile(
    standardCursorHomePath({ platform, environment, home }),
    platform,
  );
  const present = yield* probe.cliAuthFileExists(loginFile);
  if (present) return { kind: "cli" as const } satisfies CursorExistingLogin;
  return { kind: "none" as const } satisfies CursorExistingLogin;
});

export function describeCursorExistingLogin(existing: CursorExistingLogin): {
  readonly message: string;
  readonly authEmail?: string;
  readonly importable: boolean;
} {
  if (existing.kind === "sdk") {
    return {
      message: existing.email
        ? `Cursor SDK login found (${existing.email}). Enable to use it.`
        : "Cursor SDK login found on this computer. Enable to use it.",
      ...(existing.email ? { authEmail: existing.email } : {}),
      importable: true,
    };
  }
  if (existing.kind === "cli") {
    return {
      message:
        "Cursor is signed in on this computer. Set up to create a T3 agent login (the app/CLI session is not an Agent SDK key).",
      importable: false,
    };
  }
  return {
    message: "Cursor is disabled in T3 Code settings.",
    importable: false,
  };
}
