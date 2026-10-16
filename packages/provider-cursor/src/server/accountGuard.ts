/**
 * The Cursor account guard. Which folder the CLI uses comes from
 * `CursorHome` (the instance's `homePath`).
 *
 * The guard compares the CLI profile's account with the instance's SDK login
 * and refuses to use the profile when they differ, so usage limits can never
 * be read for the wrong account.
 */

import type { CursorPlatform } from "./CursorHome.ts";

export type CursorCliPlatform = CursorPlatform;

/** Extracts the signed-in email from `agent status` output. */
export function parseCursorCliStatusEmail(output: string): string | undefined {
  if (/not logged in/i.test(output)) return undefined;
  const match = /logged in as\s+(\S+@\S+)/i.exec(output);
  return match?.[1]?.replace(/[.,;]+$/, "");
}

export type CursorAccountCheck =
  | { readonly status: "match"; readonly email: string }
  | { readonly status: "cliSignedOut" }
  | { readonly status: "sdkEmailUnknown" }
  | { readonly status: "mismatch"; readonly expected: string; readonly found: string };

const normalize = (email: string) => email.trim().toLowerCase();

/** Fails closed: anything other than two equal, known emails is not a match. */
export function checkCursorAccounts(
  sdkEmail: string | undefined,
  cliEmail: string | undefined,
): CursorAccountCheck {
  if (!sdkEmail?.trim()) return { status: "sdkEmailUnknown" };
  if (!cliEmail?.trim()) return { status: "cliSignedOut" };
  return normalize(sdkEmail) === normalize(cliEmail)
    ? { status: "match", email: sdkEmail.trim() }
    : { status: "mismatch", expected: sdkEmail.trim(), found: cliEmail.trim() };
}

export function describeCursorAccountCheck(check: CursorAccountCheck): string | undefined {
  switch (check.status) {
    case "match":
      return undefined;
    case "cliSignedOut":
      return "This instance's Cursor CLI profile is signed out. Sign in to the profile for this account.";
    case "sdkEmailUnknown":
      return "Cursor did not report this instance's account email, so the CLI profile cannot be verified.";
    case "mismatch":
      return `Cursor CLI profile is signed in as ${check.found}, but this instance uses ${check.expected}. Usage limits are blocked until both match.`;
  }
}
