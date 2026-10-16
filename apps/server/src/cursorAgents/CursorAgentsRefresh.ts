import * as Effect from "effect/Effect";

/**
 * The Cursor agents handlers register one refresh effect. The scheduler tick
 * runs it. List requests never start a scan.
 */
let refresh: Effect.Effect<void> = Effect.void;

export const registerCursorAgentsRefresh = (effect: Effect.Effect<void>): void => {
  refresh = effect;
};

export const runCursorAgentsRefresh = (): Effect.Effect<void> => refresh;
