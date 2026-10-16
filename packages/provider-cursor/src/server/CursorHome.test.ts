import { describe, expect, it } from "@effect/vitest";
import {
  cursorLoginFile,
  isStandardCursorHome,
  makeCursorEnvironment,
  resolveCursorHomePath,
} from "./CursorHome.ts";

const win = {
  platform: "win32",
  environment: { APPDATA: "C:\\U\\AppData\\Roaming" },
  home: "C:\\U",
};
const linux = { platform: "linux", environment: { HOME: "/home/u" }, home: "/home/u" };

describe("CursorHome", () => {
  it("uses the standard login when homePath is empty", () => {
    expect(makeCursorEnvironment({ homePath: "" }, linux)).toBe(linux.environment);
    expect(resolveCursorHomePath({}, linux)).toBe("/home/u/.config");
    expect(isStandardCursorHome({ homePath: "" }, linux)).toBe(true);
    expect(isStandardCursorHome({}, win)).toBe(true);
  });

  it("points the CLI config folder at homePath per platform", () => {
    expect(makeCursorEnvironment({ homePath: "/home/u/c/a" }, linux)).toEqual({
      HOME: "/home/u",
      XDG_CONFIG_HOME: "/home/u/c/a",
      AGENT_CLI_CREDENTIAL_STORE: "file",
    });
    expect(makeCursorEnvironment({ homePath: "C:\\p" }, win).APPDATA).toBe("C:\\p");
    expect(isStandardCursorHome({ homePath: "/home/u/c/a" }, linux)).toBe(false);
    expect(cursorLoginFile("/home/u/c/a", "linux")).toBe("/home/u/c/a/cursor/auth.json");
    expect(cursorLoginFile("C:\\p", "win32")).toBe("C:\\p\\Cursor\\auth.json");
  });

  it("treats an explicit standard folder as the standard login on Windows", () => {
    expect(isStandardCursorHome({ homePath: "c:\\u\\appdata\\roaming\\" }, win)).toBe(true);
    expect(isStandardCursorHome({ homePath: "C:\\U\\cursor-profiles\\account-2" }, win)).toBe(
      false,
    );
  });
});
