// What is serving, and starting and stopping it.
//
// Each served profile is a systemd user unit named llmpick-<id>.service.
// systemd holds the truth about what runs, so llmpick keeps no state file:
// a server outlives the shell that started it, its output goes to the
// journal, and status is correct after a crash or a reboot.

import { existsSync, statSync } from "node:fs";
import { type Config, type ModelFile, type Profile, UserError } from "./config";

const unitName = (id: string) => `llmpick-${id}.service`;
const HEALTH = "/health";
const READY_TIMEOUT_SECONDS = 900;

export type Unit = {
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  pid: number | null;
  since: number | null; // epoch seconds
  ram: number | null; // bytes the process itself holds in RAM
  cache: number | null; // bytes of files (the model, mostly) the kernel keeps in RAM for it and can drop
  swap: number | null; // bytes pushed out to swap
  exitCode: number | null; // set when failed
};

export type ProfileStatus = {
  profile: Profile;
  unit: Unit;
  healthy: boolean;
  bin: string | null; // resolved engine binary, null when not installed
  files: (ModelFile & { size: number | null })[]; // size in bytes, null when the file is not there
  vram: number | null; // MiB held by the unit's main process
};

export type Gpu = {
  used: number; // MiB
  total: number;
  apps: { pid: number; used: number; name: string }[];
};

export type Snapshot = { profiles: ProfileStatus[]; gpu: Gpu | null };

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

async function systemctl(...args: string[]): Promise<string> {
  const r = await run(["systemctl", "--user", ...args]);
  if (r.code !== 0) throw new Error(`systemctl ${args.join(" ")} failed: ${r.err.trim()}`);
  return r.out;
}

/** Runs a command on the user's terminal. Ctrl-C ends the command, not llmpick. */
export async function attach(cmd: string[]): Promise<number> {
  const quiet = () => {};
  process.on("SIGINT", quiet);
  try {
    return await Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  } finally {
    process.off("SIGINT", quiet);
  }
}

const STATES: Record<string, Unit["state"]> = {
  active: "running",
  reloading: "running",
  activating: "starting",
  deactivating: "stopping",
  failed: "failed",
  inactive: "stopped", // also what systemd reports for a unit that does not exist
};

/** The units of these profiles, from one systemctl call. */
async function units(ids: string[]): Promise<Map<string, Unit>> {
  const out = await systemctl(
    "show", ...ids.map(unitName), "--timestamp=unix",
    "-p", "Id,ActiveState,MainPID,ActiveEnterTimestamp,ControlGroup,MemorySwapCurrent,ExecMainStatus",
  );
  const found = new Map<string, Unit>();
  for (const block of out.trim().split("\n\n")) {
    const f = Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const state = STATES[f.ActiveState];
    if (!state) throw new Error(`systemd reports ${f.Id} as "${f.ActiveState}", which llmpick does not know`);
    const live = state !== "stopped" && state !== "failed";
    const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
    // systemd reports one memory total; the cgroup file separates the process's own memory from cached files.
    const stat = live ? await Bun.file(`/sys/fs/cgroup${f.ControlGroup}/memory.stat`).text() : "";
    const bytes = (key: string) => num(stat.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1] ?? "");
    found.set(f.Id, {
      state,
      pid: live ? num(f.MainPID) : null,
      since: live ? num(f.ActiveEnterTimestamp.replace(/^@/, "")) : null,
      ram: bytes("anon"),
      cache: bytes("file"),
      swap: live ? num(f.MemorySwapCurrent) : null,
      exitCode: state === "failed" ? num(f.ExecMainStatus) : null,
    });
  }
  return new Map(ids.map((id) => [id, found.get(unitName(id))!]));
}

async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}${HEALTH}`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false; // nothing listening yet
  }
}

async function gpu(): Promise<Gpu | null> {
  if (!Bun.which("nvidia-smi")) return null;
  const query = (what: string) => run(["nvidia-smi", `--query-${what}`, "--format=csv,noheader,nounits"]);
  const [mem, apps] = await Promise.all([query("gpu=memory.used,memory.total"), query("compute-apps=pid,used_memory,process_name")]);
  if (mem.code !== 0) return null;
  const cells = (text: string) => text.trim().split("\n").filter(Boolean).map((l) => l.split(",").map((s) => s.trim()));
  const [used, total] = cells(mem.out)[0].map(Number);
  return { used, total, apps: cells(apps.out).map(([pid, mib, name]) => ({ pid: Number(pid), used: Number(mib), name })) };
}

function resolveBin(p: Profile): string | null {
  const e = p.engine;
  if (e.requires && !existsSync(e.requires)) return null;
  return e.bin.includes("/") ? (existsSync(e.bin) ? e.bin : null) : Bun.which(e.bin);
}

export async function snapshot(cfg: Config): Promise<Snapshot> {
  const [g, us] = await Promise.all([gpu(), units(cfg.profiles.map((p) => p.id))]);
  const profiles = await Promise.all(
    cfg.profiles.map(async (profile): Promise<ProfileStatus> => {
      const unit = us.get(profile.id)!;
      return {
        profile,
        unit,
        healthy: unit.state === "running" && (await healthy(profile.port)),
        bin: resolveBin(profile),
        files: profile.files.map((f) => ({ ...f, size: statSync(f.path, { throwIfNoEntry: false })?.size ?? null })),
        vram: g?.apps.find((a) => a.pid === unit.pid)?.used ?? null,
      };
    }),
  );
  return { profiles, gpu: g };
}

export const isLive = (s: ProfileStatus) => s.unit.state !== "stopped" && s.unit.state !== "failed";
export const missing = (s: ProfileStatus) => s.files.filter((f) => f.size === null);
export const live = (snap: Snapshot) => snap.profiles.filter(isLive);
export const statusOf = (snap: Snapshot, p: Profile) => snap.profiles.find((s) => s.profile.id === p.id)!;

/** What starting a profile takes right now. */
export type Plan =
  | { kind: "blocked"; why: string }
  | { kind: "download"; command: string[] }
  | { kind: "go"; stops: string[] }; // ids serving now, stopped first; may be the profile itself

export function plan(snap: Snapshot, s: ProfileStatus): Plan {
  const p = s.profile;
  if (!s.bin) return { kind: "blocked", why: `${p.engine.name} is not installed (looked for ${p.engine.requires ?? p.engine.bin})` };
  if (missing(s).length) {
    const names = missing(s).map((f) => f.name);
    return p.repo
      ? { kind: "download", command: ["hf", "download", p.repo, ...names, "--local-dir", p.dir] }
      : { kind: "blocked", why: `${names.join(", ")} missing from ${p.dir}, and the profile has no repo to download from` };
  }
  return { kind: "go", stops: live(snap).map((x) => x.profile.id) };
}

/** Stops everything llmpick is serving and returns the ids it stopped. */
export async function stopAll(cfg: Config): Promise<string[]> {
  const ids = live(await snapshot(cfg)).map((s) => s.profile.id);
  for (const id of ids) await systemctl("stop", unitName(id));
  return ids;
}

export function logCommand(id: string, lines: number, follow: boolean): string[] {
  return ["journalctl", "--user", "-u", unitName(id), "-o", "cat", "-n", String(lines), follow ? "-f" : "--no-pager"];
}

const logTail = async (id: string, lines: number) => (await run(logCommand(id, lines, false))).out.trimEnd();

async function portHolder(port: number): Promise<string | null> {
  const { out } = await run(["ss", "-ltnpH", `sport = :${port}`]);
  if (!out.trim()) return null;
  const m = out.match(/\(\("([^"]+)",pid=(\d+)/);
  return m ? `${m[1]} (pid ${m[2]})` : "another user's process";
}

/**
 * Serves this profile and nothing else: stops whatever llmpick is serving
 * (the card holds one model at a time), starts the profile, and returns once
 * it answers its health check. Throws if it cannot start or exits first.
 */
export async function serve(cfg: Config, p: Profile, onStage: (stage: string, detail: string) => void): Promise<void> {
  const snap = await snapshot(cfg);
  const s = statusOf(snap, p);
  const todo = plan(snap, s);
  if (todo.kind !== "go") throw new UserError(`Cannot start ${p.id}: ${todo.kind === "blocked" ? todo.why : "its files are not downloaded"}`);

  for (const id of todo.stops) {
    onStage(`stopping ${id}`, "");
    await systemctl("stop", unitName(id));
  }
  const holder = await portHolder(p.port);
  if (holder) throw new UserError(`Cannot start ${p.id}: port ${p.port} is held by ${holder}, which llmpick did not start`);

  onStage(`starting ${p.id}`, "");
  const unit = unitName(p.id);
  await run(["systemctl", "--user", "reset-failed", unit]); // clears a crashed earlier run; an error means there was none
  const started = await run([
    "systemd-run", "--user", "--quiet", `--unit=${unit}`,
    `--description=llmpick ${p.id} (${p.engine.name} ${p.engine.version})`,
    `--setenv=PATH=${process.env.PATH ?? ""}`,
    ...(p.engine.cwd ? [`--working-directory=${p.engine.cwd}`] : []),
    "--", s.bin!, ...p.args,
  ]);
  if (started.code !== 0) throw new Error(`systemd would not start ${p.id}: ${started.err.trim()}`);

  for (let seconds = 0; ; seconds++) {
    const u = (await units([p.id])).get(p.id)!;
    if (u.state === "failed" || u.state === "stopped")
      throw new Error(`${p.id} exited while starting${u.exitCode !== null ? ` (exit ${u.exitCode})` : ""}. Last output:\n${await logTail(p.id, 15)}`);
    if (await healthy(p.port)) return;
    if (seconds > READY_TIMEOUT_SECONDS)
      throw new Error(`${p.id} is running but has not answered ${HEALTH} after ${READY_TIMEOUT_SECONDS}s. See: llmpick logs ${p.id}`);
    onStage(`loading ${p.id}`, `${seconds}s  ${(await logTail(p.id, 1)).slice(0, 200)}`);
    await Bun.sleep(1000);
  }
}

export async function freeSpace(dir: string): Promise<string> {
  let d = dir; // the folder may not exist before the first download
  while (!existsSync(d)) d = d.replace(/\/[^/]*$/, "") || "/";
  return (await run(["df", "-h", "--output=avail", d])).out.trim().split("\n").pop()!.trim();
}
