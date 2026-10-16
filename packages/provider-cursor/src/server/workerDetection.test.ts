import { describe, expect, it } from "@effect/vitest";

import { findProfileWorkers } from "./CursorMachine.ts";

const profile = String.raw`C:\Users\me\.t3\userdata\cursor-workers\cursor_account_1`;
const data = String.raw`C:\Users\me\.t3\userdata\cursor-workers\cursor_account_1\data`;

describe("findProfileWorkers", () => {
  it("finds this profile's worker tree root and logon watchdog only", () => {
    const found = findProfileWorkers(
      [
        {
          pid: 10,
          parentPid: 1,
          commandLine: `cmd.exe /d /s /c "cursor-agent worker --name a --worker-dir C:\\x --data-dir ${data} start"`,
        },
        {
          pid: 11,
          parentPid: 10,
          commandLine: `powershell.exe -File cursor-agent.ps1 worker --name a --data-dir ${data} start`,
        },
        {
          pid: 20,
          parentPid: 1,
          commandLine: `cmd.exe /c cursor-agent worker --data-dir ${data}0 start`,
        },
        {
          pid: 30,
          parentPid: 1,
          commandLine: String.raw`powershell.exe -File C:\Users\me\AppData\Local\CursorAgentWorker\Run-Worker.ps1`,
        },
        {
          pid: 31,
          parentPid: 1,
          commandLine: String.raw`cursor-agent worker --data-dir C:\Users\me\AppData\Local\cursor-agent start`,
        },
        {
          pid: 40,
          parentPid: 1,
          commandLine: `powershell.exe -NoProfile -WindowStyle Hidden -File "${profile}\\logon\\Run-Worker.ps1"`,
        },
      ],
      profile,
      "win32",
    );
    expect(found.roots.map((p) => p.pid)).toEqual([10]);
    expect(found.watchdogs.map((p) => p.pid)).toEqual([40]);
  });

  it("finds nothing when no worker of the profile runs", () => {
    const found = findProfileWorkers(
      [{ pid: 31, parentPid: 1, commandLine: "cursor-agent worker --data-dir C:\\other start" }],
      profile,
      "win32",
    );
    expect(found.roots).toEqual([]);
    expect(found.watchdogs).toEqual([]);
  });
});
