import type { SdkCredentialStore } from "@cursor/sdk";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

const Credentials = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    backendUrl: Schema.String,
    apiKey: Schema.String,
    createdAtMs: Schema.Finite,
    apiKeyExpiresAtMs: Schema.optionalKey(Schema.Finite),
    email: Schema.optionalKey(Schema.String),
  }),
);

const decodeCredentials = Schema.decodeUnknownEffect(Credentials);
const encodeCredentials = Schema.encodeEffect(Credentials);

/**
 * The SDK owns the credential format; persistence uses the environment's secret store.
 * `legacyFile` is the SDK file store earlier versions used; its sign-in moves into
 * the secret store once and the file is deleted.
 */
export const makeCursorCredentialStore = Effect.fn("makeCursorCredentialStore")(function* (
  instanceId: ProviderInstanceId,
  legacyFile?: string,
  /**
   * Machine-wide SDK login (`~/.cursor/sdk/auth.json`). Copied into the instance
   * secret store when empty so "Use existing" works like Codex's CLI session.
   * Never deleted — other tools may still read it.
   */
  sharedSdkAuthFile?: string,
) {
  const credentials = yield* (yield* ProviderHost.ProviderHost).credentials("cursor", instanceId);
  const fileSystem = yield* FileSystem.FileSystem;
  const importCredentialsFile = (
    filePath: string,
    options: { readonly deleteAfter: boolean; readonly label: string },
  ) =>
    Effect.gen(function* () {
      const legacy = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
      if (Option.isNone(legacy)) return;
      // A stored sign-in wins unless it is damaged; the SDK would ignore it anyway.
      const stored = yield* credentials.get;
      const storedIsValid =
        Option.isSome(stored) &&
        Option.isSome(
          yield* decodeCredentials(new TextDecoder().decode(stored.value)).pipe(Effect.option),
        );
      if (
        !storedIsValid &&
        Option.isSome(yield* decodeCredentials(legacy.value).pipe(Effect.option))
      ) {
        yield* credentials.set(new TextEncoder().encode(legacy.value));
      }
      if (options.deleteAfter) {
        yield* fileSystem.remove(filePath);
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Could not migrate ${options.label} Cursor credentials`, error),
      ),
    );
  if (legacyFile !== undefined) {
    yield* importCredentialsFile(legacyFile, { deleteAfter: true, label: "legacy" });
  }
  if (sharedSdkAuthFile !== undefined) {
    yield* importCredentialsFile(sharedSdkAuthFile, {
      deleteAfter: false,
      label: "shared SDK",
    });
  }
  const store: SdkCredentialStore = {
    load: () =>
      Effect.runPromise(
        credentials.get.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(undefined),
              onSome: (bytes) =>
                decodeCredentials(new TextDecoder().decode(bytes)).pipe(
                  Effect.orElseSucceed(() => undefined),
                ),
            }),
          ),
        ),
      ),
    save: (value) =>
      Effect.runPromise(
        encodeCredentials(value).pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "credentials",
                detail: "Cursor returned an unsupported credential format.",
              }),
          ),
          Effect.flatMap((encoded) => credentials.set(new TextEncoder().encode(encoded))),
        ),
      ),
    clear: () => Effect.runPromise(credentials.remove),
  };
  return { store, binding: credentials.binding };
});
