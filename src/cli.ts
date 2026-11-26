#!/usr/bin/env bun
// llmpick: choose which local model is served, and see and stop what is.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import guide from "../AGENTS.md" with { type: "text" };
import example from "../profiles.example.toml" with { type: "text" };
import { version } from "../package.json";
import { type Profile, UserError, configPath, loadConfig, resolve, search } from "./config";
import { type ProfileStatus, type Snapshot, askVersions, attach, endpoint, freeSpace, live, logCommand, plan, serve, snapshot, statusOf, stopAll, sync } from "./runtime";
import { COLUMNS, ago, bold, detail, dim, engineLabel, harnessLine, memoryLine, mib, pad, phase, red, speed, stopQuestion, visible } from "./ui";

const HELP = `llmpick: choose which local model is served, and see and stop what is.

  llmpick                     dashboard (in a terminal); otherwise the same as status
  llmpick status              what is serving now, and what holds the GPU
  llmpick stop                stop what is serving
  llmpick start <profile>     serve it; stops whatever llmpick is serving first
  llmpick restart             stop and start what is serving
  llmpick logs [profile]      server output; -f to follow, -n N for N lines
  llmpick ls [terms]          all profiles, or those matching the terms
  llmpick show <profile>      one profile in full: files, speeds, command
  llmpick download <profile>  fetch the profile's missing model files
  llmpick init                write a starter profiles file to edit
  llmpick agents              print the guide for coding agents: commands, output, cautions
  llmpick sync                point harnesses at what is serving (llmpick does this itself)

  <profile> is an id, or words that match exactly one profile (llmpick start ink 5.4).
  -y, --yes   do not ask before stopping or downloading
  --json      machine-readable output for status and ls
  --version   print the version

Engines and models are defined in ~/.config/llmpick/profiles.toml.`;

const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;

const toJson = (s: ProfileStatus) => ({
  id: s.profile.id,
  engine: engineLabel(s),
  state: phase(s).word,
  endpoint: endpoint(s.profile),
  pid: s.unit.pid,
  since: s.unit.since,
  vram_mib: s.vram,
  harnesses: s.harnesses.map((h) => ({ name: h.name, model: h.model })),
});

/** A harness config llmpick could not update is worth saying, and no reason to fail the command. */
const warn = (problems: string[]) => problems.forEach((m) => console.error(`Harness not updated: ${m}`));

function printStatus(snap: Snapshot, json: boolean) {
  const serving = live(snap);
  const crashed = snap.profiles.filter((s) => s.unit.state === "failed");
  if (json)
    return console.log(JSON.stringify({ serving: serving.map(toJson), crashed: crashed.map((s) => s.profile.id), gpu: snap.gpu, problems: snap.problems }, null, 2));
  warn(snap.problems);

  if (!serving.length) console.log(`Nothing is serving. ${dim("Start a profile: llmpick start <profile>   List them: llmpick ls")}`);
  for (const s of serving) {
    const ph = phase(s);
    console.log(`${ph.dot} ${bold(s.profile.id)}  ${ph.label}${s.unit.since ? ` for ${ago(s.unit.since)}` : ""}`);
    console.log(`  endpoint  ${endpoint(s.profile)}`);
    if (harnessLine(s)) console.log(`  model     ${harnessLine(s)}`);
    console.log(`  engine    ${engineLabel(s)}`);
    console.log(`  process   pid ${s.unit.pid}`);
    console.log(`  memory    ${memoryLine(s)}`);
    console.log(`  stop      llmpick stop        ${dim("logs: llmpick logs -f")}`);
  }
  for (const s of crashed) console.log(`${phase(s).dot} ${bold(s.profile.id)}  ${phase(s).label}  ${dim(`see: llmpick logs ${s.profile.id}`)}`);

  const g = snap.gpu;
  if (!g) return;
  console.log(`\nGPU  ${mib(g.used)} of ${mib(g.total)} in use`);
  for (const a of g.apps) {
    const ours = serving.find((s) => s.unit.pid === a.pid);
    console.log(`     ${pad(mib(a.used), 8)} ${a.name.split("/").pop()} (pid ${a.pid})${ours ? dim(`  ${ours.profile.id}`) : ""}`);
  }
}

function printList(list: ProfileStatus[], json: boolean) {
  if (json) return console.log(JSON.stringify(list.map(toJson), null, 2));
  const idW = Math.max(COLUMNS.id.length, ...list.map((s) => s.profile.id.length));
  const speedW = Math.max(COLUMNS.speed.length, ...list.map((s) => visible(speed(s))));
  console.log(dim(`  ${pad(COLUMNS.id, idW)}  ${pad(COLUMNS.state, 14)}  ${pad(COLUMNS.speed, speedW)}  ${COLUMNS.engine}`));
  for (const s of list) console.log(`${phase(s).dot} ${pad(bold(s.profile.id), idW)}  ${pad(phase(s).label, 14)}  ${pad(speed(s), speedW)}  ${dim(engineLabel(s))}`);
}

function printDetail(s: ProfileStatus) {
  console.log(`${phase(s).dot} ${bold(s.profile.id)}`);
  for (const [k, v] of detail(s)) console.log(`  ${pad(dim(k), 10)} ${v.replaceAll("\n", "\n" + " ".repeat(13))}`);
}

async function main() {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      json: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n", default: "60" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
  });
  if (flags.help) return console.log(HELP);
  if (flags.version) return console.log(version);
  const [cmd, ...terms] = positionals;
  if (cmd === "agents") return console.log(guide);
  if (cmd === "init") {
    const path = configPath();
    if (existsSync(path)) throw new UserError(`${path} already exists; edit it instead.`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, example);
    return console.log(`Wrote ${path}\nEdit it to describe your engines and models, then run: llmpick ls`);
  }
  const cfg = await askVersions(loadConfig());
  // Asks only a person: a script or agent that runs a command means it.
  const confirm = (question: string) => flags.yes || !tty || /^y(es)?$/i.test((prompt(`${question} [y/N]`) ?? "").trim());

  async function start(p: Profile, sure: boolean) {
    const snap = await snapshot(cfg);
    const todo = plan(snap, statusOf(snap, p));
    if (todo.kind === "blocked") throw new UserError(`Cannot start ${p.id}: ${todo.why}`);
    if (todo.kind === "download") throw new UserError(`${p.id} is not downloaded. Run: llmpick download ${p.id}`);
    const question = stopQuestion(p.id, todo.stops);
    if (question && !sure && !confirm(question)) return;
    let shown = "";
    const problems = await serve(cfg, p, (stage) => {
      if (stage !== shown) console.log(dim(stage));
      shown = stage;
    });
    printStatus({ ...(await snapshot(cfg)), problems }, flags.json);
  }

  switch (cmd) {
    case undefined:
      if (tty) return (await import("./tui")).dashboard(cfg);
    // Without a terminal there is no dashboard to show.
    case "status":
      return printStatus(await sync(cfg), flags.json);
    case "sync": {
      const { problems } = await sync(cfg);
      if (problems.length) throw new UserError(problems.map((m) => `Harness not updated: ${m}`).join("\n"));
      return;
    }
    case "ls": {
      const snap = await snapshot(cfg);
      const hits = search(cfg, terms).map((p) => statusOf(snap, p));
      if (!hits.length) throw new UserError(`No profile matches "${terms.join(" ")}"`);
      return printList(hits, flags.json);
    }
    case "show":
      return printDetail(statusOf(await snapshot(cfg), resolve(cfg, terms)));
    case "start":
      return start(resolve(cfg, terms), false);
    case "restart": {
      const [serving] = live(await snapshot(cfg));
      if (!serving) throw new UserError("Nothing is serving, so there is nothing to restart");
      return start(serving.profile, true);
    }
    case "stop": {
      const { stopped, problems } = await stopAll(cfg);
      console.log(stopped.length ? `Stopped ${stopped.join(", ")}.` : "Nothing is serving.");
      return warn(problems);
    }
    case "logs": {
      const id = terms.length ? resolve(cfg, terms).id : live(await snapshot(cfg))[0]?.profile.id;
      if (!id) throw new UserError("Nothing is serving. Name a profile to see its last run: llmpick logs <profile>");
      process.exitCode = await attach(logCommand(id, Number(flags.lines), flags.follow));
      return;
    }
    case "download": {
      const p = resolve(cfg, terms);
      const snap = await snapshot(cfg);
      const todo = plan(snap, statusOf(snap, p));
      if (todo.kind === "blocked") throw new UserError(`Cannot download ${p.id}: ${todo.why}`);
      if (todo.kind === "go") return console.log(`${p.id}: every file is already in ${p.dir}`);
      console.log(`${dim("$")} ${todo.command.join(" ")}\n${dim(`${await freeSpace(p.dir)} free in ${p.dir}`)}`);
      if (confirm("Download now?")) process.exitCode = await attach(todo.command);
      return;
    }
    default:
      throw new UserError(`"${cmd}" is not a command. See llmpick --help`);
  }
}

main().catch((e) => {
  if (e instanceof UserError || e?.code?.startsWith?.("ERR_PARSE_ARGS")) console.error(e.message);
  else console.error(red("llmpick failed: ") + (e?.stack ?? e));
  process.exit(1);
});
