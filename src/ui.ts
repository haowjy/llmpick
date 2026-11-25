// Wording and formatting shared by the commands and the dashboard.

import { type ProfileStatus, missing } from "./runtime";

const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = sgr("1");
export const dim = sgr("2");
export const red = sgr("31");
export const green = sgr("32");
export const yellow = sgr("33");

export const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
export const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s)));

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
export const mib = (m: number) => `${(m / 1024).toFixed(1)} GB`;

export function ago(epochSeconds: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  return h < 48 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** A profile's standing: the plain word (also the JSON `state`), and its marker and label as shown. */
export function phase(s: ProfileStatus): { word: string; dot: string; label: string } {
  const u = s.unit;
  const plain = (text: string) => text;
  const [word, paint, dot]: [string, (text: string) => string, string] =
    u.state === "running" ? (s.healthy ? ["serving", green, "●"] : ["loading", yellow, "●"])
    : u.state === "starting" || u.state === "stopping" ? [u.state, yellow, "●"]
    : u.state === "failed" ? ["crashed", red, "✗"]
    : !s.bin ? ["engine missing", dim, "○"]
    : missing(s).length ? ["not downloaded", dim, "○"]
    : ["available", plain, "○"];
  return { word, dot: paint(dot), label: paint(u.exitCode === null ? word : `${word} (exit ${u.exitCode})`) };
}

/** Where a serving profile's memory is: on the card, in RAM, in swap, and how much of its files the kernel has cached. */
export function memoryLine(s: ProfileStatus): string {
  const parts = [s.vram ? `${mib(s.vram)} VRAM` : "", s.unit.ram ? `${gb(s.unit.ram)} RAM` : "", s.unit.swap ? yellow(`${gb(s.unit.swap)} in swap`) : "", s.unit.cache ? dim(`${gb(s.unit.cache)} file cache`) : ""];
  return parts.filter(Boolean).join("   ");
}

export const endpoint = (s: ProfileStatus) => `http://127.0.0.1:${s.profile.port}/v1`;
export const engineLabel = (s: ProfileStatus) => `${s.profile.engine.name} ${s.profile.engine.version}`;

/** The headline speed for a list row: measured here if known, else the published figure, dimmed and marked "pub". */
export function speed(s: ProfileStatus): string {
  const p = s.profile;
  const head = (text: string | undefined) => text?.split("/")[0].trim().replace(/\d+\.\d+/g, (n) => String(Math.round(Number(n)))) ?? "";
  if (p.local) return `${head(p.local)} tok/s`;
  return /^[\d-]+$/.test(head(p.published)) ? dim(`${head(p.published)} tok/s pub`) : "";
}

/** The question to ask before serving a profile, or null when nothing has to stop. */
export function stopQuestion(id: string, stops: string[]): string | null {
  if (!stops.length) return null;
  return stops.length === 1 && stops[0] === id ? `Restart ${id}?` : `Stop ${stops.join(", ")} and start ${id}?`;
}

/** Everything about one profile, as label and value pairs. */
export function detail(s: ProfileStatus): [string, string][] {
  const p = s.profile;
  const rows: [string, string][] = [];
  const add = (label: string, value: string | undefined) => value && rows.push([label, value]);
  add("engine", `${engineLabel(s)}  ${s.bin ? dim(s.bin) : red(`not installed (${p.engine.requires ?? p.engine.bin})`)}`);
  add("context", p.context);
  for (const f of s.files) add(f.key, f.size === null ? `${red("✗")} ${f.name} ${red("missing")}` : `${green("✓")} ${f.name} ${dim(gb(f.size))}`);
  add("folder", p.dir && p.dir + (p.repo ? dim(`  from ${p.repo}`) : ""));
  add("published", p.published && `${p.published} ${dim("tok/s")}`);
  add("measured", p.local && `${p.local} ${dim("tok/s here")}`);
  add("endpoint", endpoint(s));
  // One option per line: it reads better than a wrapped line and survives a narrow terminal.
  add("command", [p.engine.bin, ...p.args].map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ").replace(/ (?=-)/g, "\n  "));
  add("note", p.note);
  return rows;
}
