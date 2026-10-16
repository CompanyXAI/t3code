import { describe, expect, it } from "@effect/vitest";
import { makeCursorMachine } from "./CursorMachine.ts";

const winEnv = { APPDATA: "C:\\Users\\example\\AppData\\Roaming" };
const home = "C:\\Users\\example";

describe("standard Cursor login", () => {
  it("is an ordinary instance: logout runs through the standard login", async () => {
    const calls: Array<{ args: string; appData: string | undefined }> = [];
    const machine = makeCursorMachine(
      { homePath: "" },
      {
        platform: "win32",
        environment: winEnv,
        home,
        workerRoot: "C:\\Users\\example\\.t3\\userdata\\cursor-workers\\cursor_account_1",
        sdkEmail: async () => "a@example.com",
        run: async (_file, args, env) => {
          calls.push({ args: args.join(" "), appData: env.APPDATA });
          return "";
        },
      },
    );
    await machine.logout();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("logout");
    expect(calls[0]!.appData).toBe(winEnv.APPDATA);
  });

  it("never claims a worker that T3 did not start in this home", async () => {
    const machine = makeCursorMachine(
      { homePath: "" },
      {
        platform: "win32",
        environment: winEnv,
        home,
        workerRoot: "C:\\Users\\example\\.t3\\userdata\\cursor-workers\\cursor_account_1",
        sdkEmail: async () => undefined,
        run: async () => "",
        listProcesses: async () => [
          {
            pid: 17972,
            parentPid: 1,
            commandLine:
              'powershell.exe -NoProfile -File "C:\\Users\\example\\Desktop\\Terminal\\Run-Worker.ps1"',
          },
          {
            pid: 23640,
            parentPid: 17972,
            commandLine:
              "node.exe C:\\Users\\example\\AppData\\Local\\cursor-agent\\index.js worker --data-dir C:\\Users\\example\\AppData\\Local\\cursor-agent start",
          },
        ],
      },
    );
    const state = await machine.status();
    expect(state.standardLogin).toBe(true);
    expect(state.worker.running).toBe(false);
  });
});
