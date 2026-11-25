// Reads profiles.toml into engines and profiles.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Engine = {
  name: string;
  version: string;
  /** A path, or a command found on PATH. */
  bin: string;
  cwd?: string;
  /** A path that must exist for the engine to count as installed, when `bin` alone cannot tell. */
  requires?: string;
};

export type ModelFile = { key: string; name: string; path: string };

export type Profile = {
  id: string;
  engine: Engine;
  port: number;
  context: string;
  note: string;
  dir: string;
  repo?: string;
  files: ModelFile[];
  args: string[];
  published?: string;
  local?: string;
};

export type Config = { profiles: Profile[] };

export class UserError extends Error {}

/** ~/.config/llmpick/profiles.toml, unless LLMPICK_CONFIG names another file (for trying llmpick against dummy engines). */
export function configPath(): string {
  return process.env.LLMPICK_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "llmpick", "profiles.toml");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) throw new UserError(`No profiles file at ${path}. Create one with: llmpick init`);
  let raw: any;
  try {
    raw = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UserError(`${path} is not valid TOML: ${(e as Error).message}`);
  }
  const bad = (where: string, what: string): never => {
    throw new UserError(`${path}: ${where} ${what}`);
  };

  const engines = new Map<string, Engine>();
  for (const [id, e] of Object.entries<any>(raw.engines ?? {})) {
    if (typeof e.bin !== "string") bad(`engines.${id}`, "needs `bin`");
    engines.set(id, { name: e.name ?? id, version: e.version ?? "", bin: e.bin, cwd: e.cwd, requires: e.requires });
  }

  const profiles: Profile[] = [];
  for (const [id, p] of Object.entries<any>(raw.profiles ?? {})) {
    const where = `profiles.${id}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
      bad(where, "has an id systemd cannot use; keep to letters, digits, . _ -");
    const engine = engines.get(p.engine) ?? bad(where, `names an unknown engine "${p.engine}"`);
    if (!Number.isInteger(p.port)) bad(where, "needs an integer `port`");
    if (!Array.isArray(p.args)) bad(where, "needs `args` as a list");
    const dir: string = p.dir ?? "";
    const files: ModelFile[] = Object.entries<any>(p.files ?? {}).map(([key, name]) => ({
      key,
      name: String(name),
      path: join(dir, String(name)),
    }));
    if (files.length && !dir) bad(where, "lists `files` but has no `dir`");
    const values: Record<string, string> = { port: String(p.port), dir };
    for (const f of files) values[f.key] = f.path;
    const args = p.args.map((a: unknown) =>
      String(a).replace(/\{([A-Za-z0-9_-]+)\}/g, (_, k: string) =>
        k in values ? values[k] : bad(where, `uses {${k}} in args, which is not port, dir or a file name`),
      ),
    );
    profiles.push({
      id,
      engine,
      port: p.port,
      context: p.context ?? "",
      note: p.note ?? "",
      dir,
      repo: p.repo,
      files,
      args,
      published: p.published,
      local: p.local,
    });
  }
  if (!profiles.length) throw new UserError(`${path} defines no profiles`);
  return { profiles };
}

function haystack(p: Profile): string {
  return [p.id, p.engine.name, p.engine.version, ...p.files.map((f) => f.name)]
    .join(" ")
    .toLowerCase();
}

/** Profiles whose text contains every term. No terms matches everything. */
export function search(cfg: Config, terms: string[]): Profile[] {
  const want = terms.map((t) => t.toLowerCase()).filter(Boolean);
  return cfg.profiles.filter((p) => want.every((t) => haystack(p).includes(t)));
}

/** The one profile the terms name: an exact id, or the only search match. */
export function resolve(cfg: Config, terms: string[]): Profile {
  const ids = cfg.profiles.map((p) => p.id).join(", ");
  if (!terms.length) throw new UserError(`Name a profile. Profiles: ${ids}`);
  const exact = cfg.profiles.find((p) => p.id === terms.join(" "));
  if (exact) return exact;
  const hits = search(cfg, terms);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new UserError(`No profile matches "${terms.join(" ")}". Profiles: ${ids}`);
  throw new UserError(
    `"${terms.join(" ")}" matches ${hits.length} profiles: ${hits.map((p) => p.id).join(", ")}. Use one id.`,
  );
}
