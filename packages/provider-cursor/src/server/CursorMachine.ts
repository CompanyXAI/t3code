// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- spawns the Cursor CLI, supervises its worker and writes logon scripts.
/**
 * Machine-side controls for one Cursor instance's CLI profile: sign in and
 * out of the profile, run a personal "My Machines" worker under that
 * profile's account, and install a hidden logon task that starts it.
 *
 * Every worker gets its own `--data-dir` inside the profile folder, because
 * the CLI's worker lock lives in the data dir. That is what lets several
 * accounts run workers on one machine side by side. Before a worker starts,
 * the profile's account must match the instance's account (fail closed).
 *
 * @module provider-cursor/server/CursorMachine
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  checkCursorAccounts,
  describeCursorAccountCheck,
  parseCursorCliStatusEmail,
  type CursorCliPlatform,
} from "./accountGuard.ts";
import {
  isStandardCursorHome,
  makeCursorEnvironment,
  resolveCursorHomePath,
  type CursorHomeConfig,
} from "./CursorHome.ts";
import { CURSOR_CLI_BINARY } from "./profileUsage.ts";
import { workerNameOf } from "./runsOn.ts";

export { cursorWorkerRoot } from "./runsOn.ts";

export const WORKER_RESTART_DELAY_MS = 10_000;
export const LOGIN_TIMEOUT_MS = 300_000;

export interface CursorWorkerOptions {
  readonly name: string;
  readonly workerDir: string;
  readonly labels: ReadonlyArray<string>;
}

/**
 * Folders of one instance's worker inside `workerRoot`, which T3 keeps in its
 * own state folder (one per instance, side by side), apart from the login home.
 */
export const machinePaths = (workerRoot: string) => ({
  dataDir: NodePath.join(workerRoot, "data"),
  logDir: NodePath.join(workerRoot, "logs"),
  scriptDir: NodePath.join(workerRoot, "logon"),
});

const LABEL = /^[A-Za-z0-9_.-]+=[A-Za-z0-9_.:/@-]+$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Validates worker options; returns a problem or undefined. Values reach a command line. */
export function workerOptionsProblem(options: CursorWorkerOptions): string | undefined {
  if (!NAME.test(options.name))
    return "Worker name may only use letters, digits, '.', '_' and '-'.";
  if (!NodePath.isAbsolute(options.workerDir)) return "Worker folder must be an absolute path.";
  if (/["%`$\r\n]/.test(options.workerDir)) return "Worker folder contains unsupported characters.";
  const bad = options.labels.find((label) => !LABEL.test(label));
  return bad === undefined ? undefined : `Label '${bad}' must look like key=value.`;
}

export function workerArgs(workerRoot: string, options: CursorWorkerOptions): Array<string> {
  return [
    "worker",
    "--name",
    options.name,
    "--worker-dir",
    options.workerDir,
    "--data-dir",
    machinePaths(workerRoot).dataDir,
    ...options.labels.flatMap((label) => ["--label", label]),
    "start",
  ];
}

export interface RunningProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly commandLine: string;
}

/** True when `commandLine` passes exactly `value` (not a longer path) after `flag`. */
function hasExactArg(commandLine: string, flag: string, value: string): boolean {
  for (const form of [`${flag} ${value}`, `${flag} "${value}"`]) {
    let at = commandLine.indexOf(form);
    while (at !== -1) {
      const next = commandLine.charAt(at + form.length);
      if (next === "" || next === " " || next === '"') return true;
      at = commandLine.indexOf(form, at + 1);
    }
  }
  return false;
}

/**
 * Worker processes of one instance, found by its own `--data-dir`, and the
 * watchdog of its logon task, found by its own Run-Worker.ps1. Both paths
 * live inside the instance's worker root, so a worker of another account or a
 * hand-made worker elsewhere never matches.
 * `roots` are the topmost worker processes; killing their trees stops them.
 */
export function findProfileWorkers(
  processes: ReadonlyArray<RunningProcess>,
  workerRoot: string,
  platform: CursorCliPlatform,
): {
  readonly roots: ReadonlyArray<RunningProcess>;
  readonly watchdogs: ReadonlyArray<RunningProcess>;
} {
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const paths = machinePaths(workerRoot);
  const dataDir = fold(paths.dataDir);
  const script = fold(NodePath.join(paths.scriptDir, "Run-Worker.ps1"));
  const workers = processes.filter((proc) => {
    const line = fold(proc.commandLine);
    return / worker /.test(` ${line} `) && hasExactArg(line, "--data-dir", dataDir);
  });
  const workerPids = new Set(workers.map((proc) => proc.pid));
  return {
    roots: workers.filter((proc) => !workerPids.has(proc.parentPid)),
    watchdogs: processes.filter((proc) =>
      hasExactArg(fold(proc.commandLine), fold("-File"), script),
    ),
  };
}

const parsePsList = (output: string): Array<RunningProcess> =>
  output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      commandLine: match[3]!.trim(),
    }));

const WINDOWS_PROCESS_QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe' or Name='node.exe' or Name='powershell.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

/** Running processes, as `findProfileWorkers` reads them. */
export async function listRunningProcesses(
  platform: CursorCliPlatform,
  env: NodeJS.ProcessEnv,
  run: (
    file: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<string> = defaultRun,
): Promise<ReadonlyArray<RunningProcess>> {
  if (platform === "win32") {
    const output = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY],
      env,
    );
    const parsed = JSON.parse(output.trim() || "[]") as
      | { ProcessId: number; ParentProcessId: number; CommandLine: string | null }
      | Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>;
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: item.ProcessId,
      parentPid: item.ParentProcessId,
      commandLine: item.CommandLine ?? "",
    }));
  }
  return parsePsList(await run("ps", ["-eo", "pid=,ppid=,args="], env));
}

/** Name of the worker running from `workerRoot` (started by T3 or at logon), if any. */
export async function runningWorkerName(
  workerRoot: string,
  platform: CursorCliPlatform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const { roots } = findProfileWorkers(
    await listRunningProcesses(platform, env),
    workerRoot,
    platform,
  );
  for (const root of roots) {
    const name = workerNameOf(root.commandLine);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** The login URL `cursor-agent login` prints when no browser is opened. */
export function parseLoginUrl(output: string): string | undefined {
  // oxlint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return /https:\/\/cursor\.com\/\S+/.exec(clean)?.[0];
}

export const logonTaskName = (instanceId: string) =>
  `T3CursorWorker-${instanceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Hidden watchdog like a hand-made Run-Worker.ps1: profile env, restart on exit, logs. */
export function windowsWorkerScript(
  homeDir: string,
  workerRoot: string,
  options: CursorWorkerOptions,
): string {
  const paths = machinePaths(workerRoot);
  const args = workerArgs(workerRoot, options).map(psQuote).join(", ");
  return [
    "# Generated by T3 Code. Runs this instance's Cursor worker under its own CLI profile.",
    "$ErrorActionPreference = 'Continue'",
    `$env:APPDATA = ${psQuote(homeDir)}`,
    "Remove-Item Env:CURSOR_API_KEY -ErrorAction SilentlyContinue",
    "Remove-Item Env:CURSOR_AUTH_TOKEN -ErrorAction SilentlyContinue",
    `$LogDir = ${psQuote(paths.logDir)}`,
    "New-Item -ItemType Directory -Force -Path $LogDir | Out-Null",
    "$Log = Join-Path $LogDir 'worker.log'",
    `$WorkerArgs = @(${args})`,
    "while ($true) {",
    "  Add-Content -Path $Log -Value ((Get-Date -Format s) + ' starting worker')",
    `  & cmd.exe /d /c ${CURSOR_CLI_BINARY} @WorkerArgs >> (Join-Path $LogDir 'worker.stdout.log') 2>&1`,
    '  Add-Content -Path $Log -Value ((Get-Date -Format s) + " worker exited $LASTEXITCODE, restart in 10s")',
    "  Start-Sleep -Seconds 10",
    "}",
    "",
  ].join("\r\n");
}

export function windowsHiddenLauncher(scriptPath: string): string {
  return [
    "' Generated by T3 Code. Starts the worker watchdog without a console window.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${scriptPath}""", 0, False`,
    "",
  ].join("\r\n");
}

export function systemdUnit(
  homeDir: string,
  workerRoot: string,
  options: CursorWorkerOptions,
  binary: string,
): string {
  const env = makeCursorEnvironment(
    { homePath: homeDir },
    { platform: "linux", environment: {}, home: "" },
  );
  const quote = (value: string) => `"${value.replace(/(["\\])/g, "\\$1")}"`;
  return [
    "[Unit]",
    "Description=T3 Code Cursor worker",
    "",
    "[Service]",
    ...Object.entries(env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`),
    "UnsetEnvironment=CURSOR_API_KEY CURSOR_AUTH_TOKEN",
    `ExecStart=${[binary, ...workerArgs(workerRoot, options)].map(quote).join(" ")}`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface CursorMachineDeps {
  readonly platform: CursorCliPlatform;
  readonly environment: NodeJS.ProcessEnv;
  /** The current user's home directory, for `~` in `homePath`. */
  readonly home: string;
  /** This instance's worker folder in T3's state folder (data, logs, logon script). */
  readonly workerRoot: string;
  readonly binary?: string;
  /** Email of the instance's SDK account, for the guard. */
  readonly sdkEmail: () => Promise<string | undefined>;
  readonly spawn?: typeof spawn;
  readonly run?: (
    file: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<string>;
  /** Running processes, for finding this profile's worker when T3 did not start it. */
  readonly listProcesses?: () => Promise<ReadonlyArray<RunningProcess>>;
}

export interface CursorWorkerState {
  readonly running: boolean;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly lastExit: string | null;
}

const defaultRun = (file: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, [...args], { env, timeout: 30_000 }, (error, stdout, stderr) =>
      error
        ? reject(Object.assign(error, { output: `${stdout}${stderr}` }))
        : resolve(`${stdout}${stderr}`),
    ),
  );

/** One per instance and Cursor home. Holds the login flow and the T3-run worker. */
export function makeCursorMachine(config: CursorHomeConfig, deps: CursorMachineDeps) {
  const context = { platform: deps.platform, environment: deps.environment, home: deps.home };
  const homeDir = resolveCursorHomePath(config, context);
  const binary = deps.binary ?? CURSOR_CLI_BINARY;
  const run = deps.run ?? defaultRun;
  const doSpawn = deps.spawn ?? spawn;
  const win = deps.platform === "win32";
  const {
    CURSOR_API_KEY: _k,
    CURSOR_AUTH_TOKEN: _t,
    ...env
  } = makeCursorEnvironment(config, context);
  const paths = machinePaths(deps.workerRoot);
  const standardLogin = isStandardCursorHome(config, context);
  const listProcesses = deps.listProcesses ?? (() => listRunningProcesses(deps.platform, env, run));
  /** Workers of this profile that T3 is not supervising (logon task, earlier T3 run). */
  const foreignWorkers = async () => {
    const found = findProfileWorkers(
      await listProcesses().catch(() => []),
      deps.workerRoot,
      deps.platform,
    );
    return {
      ...found,
      roots: found.roots.filter((proc) => proc.pid !== worker?.pid),
    };
  };
  const workerState = async (): Promise<CursorWorkerState> => {
    if (worker) return state;
    const root = (await foreignWorkers()).roots[0];
    return root === undefined
      ? state
      : { running: true, pid: root.pid, startedAt: null, lastExit: state.lastExit };
  };
  /** cmd.exe for the Windows .cmd shim; arguments are validated, never free text. */
  const command = (args: ReadonlyArray<string>): [string, Array<string>] =>
    win
      ? [
          env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", [binary, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")],
        ]
      : [binary, [...args]];

  let login: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let wanted = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let state: CursorWorkerState = { running: false, pid: null, startedAt: null, lastExit: null };

  const cliEmail = async () => {
    const [file, args] = command(["status"]);
    const output = await run(file, args, env).catch(
      (error: { output?: string }) => error.output ?? "",
    );
    return parseCursorCliStatusEmail(output);
  };

  const accountCheck = async () => checkCursorAccounts(await deps.sdkEmail(), await cliEmail());

  const status = async () => {
    const [check, current] = await Promise.all([accountCheck(), workerState()]);
    return {
      homeDir,
      cliEmail:
        check.status === "match" ? check.email : check.status === "mismatch" ? check.found : null,
      check: check.status,
      problem: describeCursorAccountCheck(check) ?? null,
      standardLogin,
      loginPending: login !== undefined,
      worker: current,
    };
  };

  const startLogin = () =>
    new Promise<string>((resolve, reject) => {
      login?.kill();
      const [file, args] = command(["login"]);
      const child = doSpawn(file, args, {
        env: { ...env, NO_OPEN_BROWSER: "1" },
        windowsHide: true,
      });
      login = child;
      let output = "";
      const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const url = parseLoginUrl(output);
        if (url) resolve(url);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", reject);
      child.on("exit", () => {
        clearTimeout(timer);
        if (login === child) login = undefined;
        reject(new Error("Cursor CLI login ended before showing a sign-in link."));
      });
    });

  const logout = async () => {
    login?.kill();
    const [file, args] = command(["logout"]);
    await run(file, args, env);
  };

  const launch = (options: CursorWorkerOptions) => {
    const [file, args] = command(workerArgs(deps.workerRoot, options));
    const child = doSpawn(file, args, {
      env,
      cwd: options.workerDir,
      windowsHide: true,
      stdio: "ignore",
    });
    worker = child;
    state = {
      running: true,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      lastExit: state.lastExit,
    };
    child.on("exit", (code, signal) => {
      if (worker !== child) return;
      worker = undefined;
      state = {
        running: false,
        pid: null,
        startedAt: null,
        lastExit: `${new Date().toISOString()} ${signal ?? `exit ${code}`}`,
      };
      if (wanted)
        restartTimer = setTimeout(() => wanted && launch(options), WORKER_RESTART_DELAY_MS);
    });
  };

  const guard = async (options: CursorWorkerOptions) => {
    const problem =
      workerOptionsProblem(options) ?? describeCursorAccountCheck(await accountCheck());
    if (problem) throw new Error(problem);
  };

  const startWorker = async (options: CursorWorkerOptions) => {
    if (worker) return state;
    // One worker per profile: its data-dir lock would make a second one fail anyway.
    const running = await workerState();
    if (running.running) return running;
    await guard(options);
    await NodeFSP.mkdir(paths.dataDir, { recursive: true });
    wanted = true;
    launch(options);
    return state;
  };

  const stopWorker = async () => {
    wanted = false;
    if (restartTimer) clearTimeout(restartTimer);
    const child = worker;
    if (child?.pid !== undefined && win) {
      // Kill the whole tree: cmd.exe shim plus the node worker below it.
      await run("taskkill", ["/PID", String(child.pid), "/T", "/F"], env).catch(() => undefined);
    } else child?.kill();
    // Also stop workers of this profile that T3 did not start itself, watchdog
    // first so it does not restart them. Only this profile's folders match.
    const foreign = await foreignWorkers();
    for (const proc of [...foreign.watchdogs, ...foreign.roots]) {
      if (win) {
        await run("taskkill", ["/PID", String(proc.pid), "/T", "/F"], env).catch(() => undefined);
      } else {
        await run("kill", [String(proc.pid)], env).catch(() => undefined);
      }
    }
    return workerState();
  };

  const taskName = (instanceId: string) => logonTaskName(instanceId);

  // Windows: a hidden launcher in the user's own Startup folder. Unlike a
  // Task Scheduler task it needs no admin prompt, and T3 can add and remove
  // it on its own.
  // The Startup folder belongs to the Windows user, not to the Cursor home:
  // env.APPDATA points at the instance home when it has its own homePath.
  const userAppData = deps.environment.APPDATA;
  const startupEntry = (instanceId: string) => {
    if (!userAppData) throw new Error("APPDATA is not set; cannot find the Startup folder.");
    return NodePath.join(
      userAppData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      `${taskName(instanceId)}.vbs`,
    );
  };

  const logonTaskInstalled = async (instanceId: string) => {
    if (win) {
      if (!userAppData) return false;
      return NodeFSP.access(startupEntry(instanceId)).then(
        () => true,
        () => false,
      );
    }
    const unit = NodePath.join(
      env.HOME ?? "",
      ".config",
      "systemd",
      "user",
      `${taskName(instanceId)}.service`,
    );
    return NodeFSP.access(unit).then(
      () => true,
      () => false,
    );
  };

  const installLogonTask = async (instanceId: string, options: CursorWorkerOptions) => {
    await guard(options);
    await NodeFSP.mkdir(paths.dataDir, { recursive: true });
    if (win) {
      await NodeFSP.mkdir(paths.scriptDir, { recursive: true });
      const script = NodePath.join(paths.scriptDir, "Run-Worker.ps1");
      const entry = startupEntry(instanceId);
      await NodeFSP.writeFile(script, windowsWorkerScript(homeDir, deps.workerRoot, options));
      await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
      await NodeFSP.writeFile(entry, windowsHiddenLauncher(script));
      return;
    }
    if (deps.platform !== "linux")
      throw new Error("Logon tasks are available on Windows and Linux.");
    const dir = NodePath.join(env.HOME ?? "", ".config", "systemd", "user");
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(dir, `${taskName(instanceId)}.service`),
      systemdUnit(homeDir, deps.workerRoot, options, binary),
    );
    await run("systemctl", ["--user", "daemon-reload"], env);
    await run("systemctl", ["--user", "enable", `${taskName(instanceId)}.service`], env);
  };

  const uninstallLogonTask = async (instanceId: string) => {
    if (win) {
      if (userAppData) await NodeFSP.rm(startupEntry(instanceId), { force: true });
      return;
    }
    const unit = `${taskName(instanceId)}.service`;
    await run("systemctl", ["--user", "disable", unit], env).catch(() => undefined);
    await NodeFSP.rm(NodePath.join(env.HOME ?? "", ".config", "systemd", "user", unit), {
      force: true,
    });
  };

  return {
    status,
    startLogin,
    logout,
    startWorker,
    stopWorker,
    logonTaskInstalled,
    installLogonTask,
    uninstallLogonTask,
  };
}

export type CursorMachine = ReturnType<typeof makeCursorMachine>;
