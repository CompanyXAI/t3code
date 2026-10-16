import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as CursorKeychain from "./CursorKeychain.ts";
import {
  CursorAccountIdentity,
  readCursorInstanceUsageLimits,
  type CursorProfileIdentity,
} from "./profileUsage.ts";

const identity = (sdk: string | undefined, cli: string, seen?: NodeJS.ProcessEnv[]) =>
  ({
    sdkEmail: async () => sdk,
    cliStatus: async (env) => {
      seen?.push(env);
      return cli;
    },
  }) satisfies CursorProfileIdentity;

const neverRequest = HttpClient.make(() => Effect.die("must not request usage"));

const run = (
  identityImpl: CursorProfileIdentity,
  client = neverRequest,
  profile = "/profiles/b",
  apiKey: string | undefined = "key-b",
) =>
  readCursorInstanceUsageLimits(
    { apiEndpoint: "https://cursor.example", homePath: profile },
    { CURSOR_API_KEY: "machine-key", CURSOR_AUTH_TOKEN: "machine-token", PATH: "/bin" },
    apiKey,
  ).pipe(
    Effect.provideService(CursorAccountIdentity, identityImpl),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, "/home/u"),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("must not read Keychain"),
    }),
    Effect.provide(NodeServices.layer),
  );

describe("readCursorInstanceUsageLimits", () => {
  it.effect("blocks a CLI profile signed in as another account", () =>
    Effect.gen(function* () {
      const limits = yield* run(identity("b@x.com", "✓ Logged in as a@x.com"));
      assert.include(limits.unavailable?.message ?? "", "a@x.com");
    }),
  );

  it.effect("blocks signed-out profiles and unknown SDK emails", () =>
    Effect.gen(function* () {
      for (const limits of [
        yield* run(identity("b@x.com", "Not logged in")),
        yield* run(identity(undefined, "✓ Logged in as b@x.com")),
        yield* run({
          sdkEmail: async () => "b@x.com",
          cliStatus: () => Promise.reject(new Error("x")),
        }),
      ]) {
        assert.strictEqual(limits.unavailable?.reason, "unsupported");
      }
    }),
  );

  it.effect("reads the profile only, never the machine credentials, when accounts match", () =>
    Effect.gen(function* () {
      const seen: NodeJS.ProcessEnv[] = [];
      const limits = yield* run(
        identity("B@x.com", "✓ Logged in as b@x.com", seen),
        HttpClient.make((request) => {
          assert.notInclude(request.headers.authorization ?? "", "machine-token");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ planUsage: { totalPercentUsed: 5 } }),
            ),
          );
        }),
      ).pipe(Effect.exit);
      assert.strictEqual(seen[0]?.XDG_CONFIG_HOME, "/profiles/b");
      assert.strictEqual(seen[0]?.CURSOR_API_KEY, undefined);
      assert.strictEqual(seen[0]?.CURSOR_AUTH_TOKEN, undefined);
      // The profile folder does not exist here, so the read fails or reports no login.
      if (limits._tag === "Success") assert.notStrictEqual(limits.value.windows[0]?.usedPercent, 5);
    }),
  );
});
