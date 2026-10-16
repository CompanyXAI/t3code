import { describe, expect, it } from "vite-plus/test";

import {
  HOST_URL_REDACT_PROPS,
  MACHINE_NAME_REDACT_PROPS,
  PATH_REDACT_PROPS,
  redactedPlaceholder,
} from "./RedactedSensitiveText";

describe("redactedPlaceholder", () => {
  it("keeps hostname punctuation so blurred hosts stay recognizable as hosts", () => {
    const host = "host.example.ts.net";
    const redacted = redactedPlaceholder(host);
    expect(redacted).toContain(".");
    expect(redacted).toContain("-");
    expect(redacted).not.toBe(host);
    expect(redacted.length).toBe(host.length);
  });

  it("keeps hyphens in machine names so blurred PC labels stay recognizable", () => {
    const name = "Machine-Alpha";
    const redacted = redactedPlaceholder(name);
    expect(redacted).toContain("-");
    expect(redacted).not.toBe(name);
    expect(redacted.length).toBe(name.length);
  });

  it("keeps email punctuation the same way account rows do", () => {
    const email = "user@example.com";
    const redacted = redactedPlaceholder(email);
    expect(redacted).toContain("@");
    expect(redacted).toContain(".");
    expect(redacted).not.toBe(email);
  });

  it("keeps path separators so blurred env paths stay recognizable as paths", () => {
    const path = String.raw`C:\Users\me\.t3\userdata\cursor-worker.env`;
    const redacted = redactedPlaceholder(path);
    expect(redacted).toContain("\\");
    expect(redacted).toContain(":");
    expect(redacted).toContain(".");
    expect(redacted).not.toBe(path);
    expect(redacted.length).toBe(path.length);
  });
});

describe("machine and host redact props", () => {
  it("reuse the email click-to-reveal wording pattern", () => {
    expect(MACHINE_NAME_REDACT_PROPS.ariaLabel).toMatch(/machine name/i);
    expect(HOST_URL_REDACT_PROPS.ariaLabel).toMatch(/host/i);
    expect(PATH_REDACT_PROPS.ariaLabel).toMatch(/path/i);
    expect(MACHINE_NAME_REDACT_PROPS.revealTooltip).toMatch(/reveal/i);
    expect(HOST_URL_REDACT_PROPS.hideTooltip).toMatch(/hide/i);
    expect(PATH_REDACT_PROPS.hideTooltip).toMatch(/hide/i);
  });
});
