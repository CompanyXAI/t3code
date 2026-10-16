// @effect-diagnostics nodeBuiltinImport:off -- runs `cursor-agent status` for the account guard.
import { execFile } from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

import type { CursorSettings } from "../settings.ts";
import {
  checkCursorAccounts,
  describeCursorAccountCheck,
  parseCursorCliStatusEmail,
} from "./accountGuard.ts";
import { makeCursorEnvironment } from "./CursorHome.ts";
import { Cursor } from "./sdk.ts";
import { readCursorUsageLimits } from "./usageLimits.ts";

export interface CursorProfileIdentity {
  /** Email of the instance's SDK login or API key. */
  readonly sdkEmail: (apiKey: string) => Promise<string | undefined>;
  /** Raw `agent status` output for the given environment. */
  readonly cliStatus: (environment: NodeJS.ProcessEnv) => Promise<string>;
}

/**
 * `cursor-agent` is the Cursor CLI's unambiguous name. The short `agent` name
 * can resolve to another vendor's CLI earlier on PATH (seen live on Windows),
 * which would report a different identity.
 */
export const CURSOR_CLI_BINARY = "cursor-agent";

export const defaultCursorProfileIdentity = (
  me: (options: { apiKey: string }) => Promise<{ readonly userEmail?: string | undefined }>,
  binary = CURSOR_CLI_BINARY,
): CursorProfileIdentity => ({
  sdkEmail: async (apiKey) => (await me({ apiKey })).userEmail,
  cliStatus: (environment) =>
    new Promise((resolve, reject) => {
      // Windows installs the CLI as a .cmd shim, which needs cmd.exe; the
      // command line is fixed, so no user input is ever concatenated.
      const [file, args] =
        process.platform === "win32"
          ? [
              environment.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
              ["/d", "/s", "/c", `${binary} status`],
            ]
          : [binary, ["status"]];
      execFile(file, args, { env: environment, timeout: 20_000 }, (error, stdout, stderr) =>
        error && !/logged in/i.test(`${stdout}${stderr}`)
          ? reject(error)
          : resolve(`${stdout}\n${stderr}`),
      );
    }),
});

/** How the account guard reads both identities; tests replace it. */
export const CursorAccountIdentity = Context.Reference<CursorProfileIdentity>(
  "@t3tools/provider-cursor/server/CursorAccountIdentity",
  { defaultValue: () => defaultCursorProfileIdentity((options) => Cursor.me(options)) },
);

/**
 * Reads plan limits from the CLI login in the instance's Cursor home (its
 * `homePath`, else the standard login). When the instance has an SDK login,
 * the CLI login must be the same account first. Fails closed.
 */
export const readCursorInstanceUsageLimits = Effect.fn("readCursorInstanceUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint" | "homePath">,
  environment: NodeJS.ProcessEnv,
  apiKey: string | undefined,
  allowKeychain = false,
) {
  const identity = yield* CursorAccountIdentity;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unavailable = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", message });
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const { CURSOR_API_KEY: _key, CURSOR_AUTH_TOKEN: _token, ...base } = environment;
  const homeEnvironment = makeCursorEnvironment(settings, { platform, environment: base, home });
  if (apiKey) {
    const identities = yield* Effect.tryPromise(() =>
      Promise.all([identity.sdkEmail(apiKey), identity.cliStatus(homeEnvironment)]),
    ).pipe(Effect.option);
    if (identities._tag === "None") {
      return unavailable("Could not verify which Cursor account this instance's CLI login uses.");
    }
    const [sdkEmail, cliOutput] = identities.value;
    const problem = describeCursorAccountCheck(
      checkCursorAccounts(sdkEmail, parseCursorCliStatusEmail(cliOutput)),
    );
    if (problem) return unavailable(problem);
  }
  return yield* readCursorUsageLimits(settings, homeEnvironment, allowKeychain);
});
