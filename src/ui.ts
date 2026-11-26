// Wording and formatting shared by the commands and the dashboard.

import { type ProfileStatus, endpoint, missing } from "./runtime";

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

/**
 * How each state looks. The marker tells states apart by shape as well as colour, because the
 * dashboard's list shows only the marker; a `faint` state also dims its whole row there.
 */
const LOOK = {
  serving: { dot: "●", paint: green },
  loading: { dot: "●", paint: yellow },
  starting: { dot: "●", paint: yellow },
  stopping: { dot: "●", paint: yellow },
  crashed: { dot: "✗", paint: red },
  available: { dot: "○", paint: (text: string) => text },
  "not downloaded": { dot: "·", paint: dim, faint: true },
  "engine missing": { dot: "·", paint: dim, faint: true },
} satisfies Record<string, { dot: string; paint: (text: string) => string; faint?: true }>;

/** A profile's standing: the plain word (also the JSON `state`), and its marker and label as shown. */
export function phase(s: ProfileStatus): { word: string; dot: string; label: string; faint: boolean } {
  const u = s.unit;
  const word: keyof typeof LOOK =
    u.state === "running" ? (s.healthy ? "serving" : "loading")
    : u.state === "starting" || u.state === "stopping" ? u.state
    : u.state === "failed" ? "crashed"
    : !s.bin ? "engine missing"
    : missing(s).length ? "not downloaded"
    : "available";
  const look: { dot: string; paint: (text: string) => string; faint?: true } = LOOK[word];
  return { word, dot: look.paint(look.dot), label: look.paint(u.exitCode === null ? word : `${word} (exit ${u.exitCode})`), faint: !!look.faint };
}

/** Where a serving profile's memory is: on the card, in RAM, in swap, and how much of its files the kernel has cached. */
export function memoryLine(s: ProfileStatus): string {
  const parts = [s.vram ? `${mib(s.vram)} VRAM` : "", s.unit.ram ? `${gb(s.unit.ram)} RAM` : "", s.unit.swap ? yellow(`${gb(s.unit.swap)} in swap`) : "", s.unit.cache ? dim(`${gb(s.unit.cache)} file cache`) : ""];
  return parts.filter(Boolean).join("   ");
}

/** What each harness calls a serving profile, harnesses that share a name together: "llmpick/local in pi, opencode". Empty when none has it. */
export function harnessLine(s: ProfileStatus): string {
  const models = [...new Set(s.harnesses.map((h) => h.model))];
  return models.map((m) => `${m} ${dim(`in ${s.harnesses.filter((h) => h.model === m).map((h) => h.name).join(", ")}`)}`).join("   ");
}
export const engineLabel = (s: ProfileStatus) => `${s.profile.engine.name} ${s.profile.engine.version}`;

/** Labels for the columns of a profile list, in the order both front ends show them. */
export const COLUMNS = { id: "profile", state: "state", speed: "tok/s", engine: "engine" };

/** The headline speed for a list row, in tok/s: measured here if known, else the published figure, dimmed and marked "pub". */
export function speed(s: ProfileStatus): string {
  const p = s.profile;
  const head = (text: string | undefined) => text?.split("/")[0].trim().replace(/\d+\.\d+/g, (n) => String(Math.round(Number(n)))) ?? "";
  if (p.local) return head(p.local);
  return /^[\d-]+$/.test(head(p.published)) ? dim(`${head(p.published)} pub`) : "";
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
  // First, because the dashboard's list shows only a marker and this is where the word is.
  add("state", phase(s).label + (s.unit.since ? ` for ${ago(s.unit.since)}` : ""));
  add("engine", `${engineLabel(s)}  ${s.bin ? dim(s.bin) : red(`not installed (${p.engine.requires ?? p.engine.bin})`)}`);
  add("context", p.context);
  for (const f of s.files) add(f.key, f.size === null ? `${red("✗")} ${f.name} ${red("missing")}` : `${green("✓")} ${f.name} ${dim(gb(f.size))}`);
  add("folder", p.dir && p.dir + (p.repo ? dim(`  from ${p.repo}`) : ""));
  add("published", p.published && `${p.published} ${dim("tok/s")}`);
  add("measured", p.local && `${p.local} ${dim("tok/s here")}`);
  add("endpoint", endpoint(p));
  // One option per line: it reads better than a wrapped line and survives a narrow terminal.
  add("command", [p.engine.bin, ...p.args].map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ").replace(/ (?=-)/g, "\n  "));
  add("note", p.note);
  return rows;
}
