import { describe, expect, it } from "vitest";

import { redactPairingUrlForLog } from "./serverRuntimeStartup.ts";

describe("redactPairingUrlForLog", () => {
  it("drops the fragment token", () => {
    const out = redactPairingUrlForLog("http://100.64.0.1:5733/pair#token=test-pairing-token");
    expect(out).toBe("http://100.64.0.1:5733/pair");
    expect(out).not.toContain("test-pairing-token");
  });

  it("drops a token query parameter and keeps others", () => {
    const out = redactPairingUrlForLog("http://localhost:13773/pair?token=test-pairing-token&x=1");
    expect(out).toBe("http://localhost:13773/pair?x=1");
  });

  it("strips everything after # or ? when the URL does not parse", () => {
    expect(redactPairingUrlForLog("not a url#token=secret")).toBe("not a url");
  });
});
