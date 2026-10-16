// @effect-diagnostics nodeBuiltinImport:off - the machine under test writes real files through node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeCursorMachine } from "./CursorMachine.ts";

describe("logon task of an instance with its own home", () => {
  it.skipIf(process.platform !== "win32")(
    "lands in the Windows user's Startup folder, not inside the Cursor home",
    async () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-startup-"));
      const userAppData = NodePath.join(root, "Roaming");
      const cursorHome = NodePath.join(root, "account-2");
      const machine = makeCursorMachine(
        { homePath: cursorHome },
        {
          platform: "win32",
          environment: { APPDATA: userAppData },
          home: root,
          workerRoot: NodePath.join(root, "workers", "cursor_account_2"),
          sdkEmail: async () => "a@example.com",
          run: async () => "Logged in as a@example.com",
        },
      );
      const options = { name: "w", workerDir: root, labels: [] };
      await machine.installLogonTask("cursor_account_2", options);
      const startup = NodePath.join(
        userAppData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
      );
      expect(NodeFS.readdirSync(startup)).toEqual(["T3CursorWorker-cursor_account_2.vbs"]);
      expect(NodeFS.existsSync(NodePath.join(cursorHome, "Microsoft"))).toBe(false);
      // Worker data and the logon script live in the worker root, not in the login home.
      expect(
        NodeFS.existsSync(
          NodePath.join(root, "workers", "cursor_account_2", "logon", "Run-Worker.ps1"),
        ),
      ).toBe(true);
      expect(NodeFS.existsSync(cursorHome)).toBe(false);
      expect(await machine.logonTaskInstalled("cursor_account_2")).toBe(true);
      await machine.uninstallLogonTask("cursor_account_2");
      expect(await machine.logonTaskInstalled("cursor_account_2")).toBe(false);
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  );
});
