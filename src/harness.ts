// Keeps coding harnesses pointed at whatever llmpick is serving.
//
// A harness is described in profiles.toml, not here: which config file it
// reads, where in that file llmpick's entry goes, and what the entry looks
// like, as a template (see template.ts). This file only knows how to put such
// an entry into a JSON file and take it out again. Serving a profile writes
// the entry, serving another rewrites it, and stopping or crashing removes it,
// so a harness can pick the model only while it can answer. The file's other
// content and its comments are never changed, and only the entry is laid out.

import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParseError, applyEdits, findNodeAtLocation, format, modify, parse, parseTree } from "jsonc-parser";
import { type Harness, type Served, UserError } from "./config";
import { fill, isTable } from "./template";

/** A path from profiles.toml: ~ is the home folder and $NAME an environment variable. Null when a variable is not set. */
function expand(path: string): string | null {
  let unset = false;
  const out = path.replace(/^~(?=\/|$)/, homedir()).replace(/\$(\w+)/g, (_, k: string) => process.env[k] || ((unset = true), "")); // empty counts as not set
  return unset ? null : out;
}

/** The environment variables the harness folders are found through. Whatever runs llmpick later needs the same ones. */
export const variables = (harnesses: Harness[]) => [...new Set(harnesses.flatMap((h) => [...h.dir.join(" ").matchAll(/\$(\w+)/g)].map((m) => m[1])))];

/** The harness's config file, or null when the harness is not set up for this user. */
function fileOf(h: Harness): string | null {
  const dir = h.dir.map(expand).find((d) => d !== null);
  if (!dir || !existsSync(dir)) return null;
  const files = h.files.map((f) => join(dir, f));
  return files.find((f) => existsSync(f)) ?? files[0];
}

/**
 * The file's text and the tables along the harness's path in it, from the
 * root down to the one that holds the entry. A file that does not exist reads
 * as empty. Throws when the file is not what llmpick can safely edit.
 */
function read(path: string, at: string[]): { text: string; tables: Record<string, unknown>[] } {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !isTable(root)) throw new UserError(`${path} could not be read as JSON, so llmpick left it alone`);
  const tables = [root];
  for (const key of at.slice(0, -1)) {
    const parent = tables.at(-1)!;
    const next = key in parent ? parent[key] : {};
    if (!isTable(next)) throw new UserError(`${path} has something other than a table at "${key}", so llmpick left it alone`);
    tables.push(next);
  }
  return { text, tables };
}

/** The harnesses whose entry points at this address. Reads only. */
export function connected(harnesses: Harness[], url: string): Harness[] {
  return harnesses.filter((h) => {
    const path = fileOf(h);
    try {
      return !!path && JSON.stringify(read(path, h.at).tables.at(-1)![h.at.at(-1)!] ?? null).includes(url);
    } catch {
      return false; // connect reports an unreadable config
    }
  });
}

/**
 * How much of `at` to remove so the entry takes with it each table that held
 * nothing else. "Nothing else" is judged on the text, not the parsed value: a
 * table with a comment in it, such as a provider the user commented out, stays.
 */
function emptied(text: string, at: string[]): string[] {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  let top = at.length;
  for (; top > 1; top--) {
    const table = tree && findNodeAtLocation(tree, at.slice(0, top - 1));
    const value = tree && findNodeAtLocation(tree, at.slice(0, top));
    if (!table || !value) break;
    const around = text.slice(table.offset, value.offset) + text.slice(value.offset + value.length, table.offset + table.length);
    const key = JSON.stringify(at[top - 1]).replace(/\s/g, "");
    if (![`{${key}:}`, `{${key}:,}`].includes(around.replace(/\s/g, ""))) break; // the second has a trailing comma
  }
  return at.slice(0, top);
}

/**
 * The text with `want` at `at`, or with that entry removed. Only the entry is
 * laid out, in the file's own indentation. A file on one line gets the entry
 * on that line, and an empty file is laid out whole.
 */
function edited(text: string, at: string[], want: unknown): string {
  if (want === undefined) return applyEdits(text, modify(text, emptied(text, at), undefined, {}));
  const edits = modify(text, at, want, {});
  const next = applyEdits(text, edits);
  const empty = text.replace(/\s/g, "") === "{}";
  if (edits.length !== 1 || (!empty && !text.trim().includes("\n"))) return next;
  const added = empty ? undefined : { offset: edits[0].offset, length: edits[0].content.length };
  // The indentation of the file's own keys, not of a comment or of a continued line.
  const indent = { insertSpaces: !/^\t+"/m.test(text), tabSize: text.match(/^( +)"/m)?.[1].length ?? 2 };
  return applyEdits(next, format(next, added, indent));
}

/** What the text holds at `at`. */
const found = (text: string, at: string[]) => at.reduce<unknown>((node, key) => (isTable(node) ? node[key] : undefined), parse(text, [], { allowTrailingComma: true }));

/**
 * Makes every installed harness's entry describe `target`, or removes it when
 * nothing is serving. A harness whose config cannot be edited is reported in
 * `problems` and does not stop the others, or whatever the caller was doing.
 */
export function connect(harnesses: Harness[], target: Served | null): { changed: boolean; problems: string[] } {
  let changed = false;
  const problems: string[] = [];
  for (const h of harnesses) {
    const path = fileOf(h);
    if (!path) continue;
    try {
      const { text, tables } = read(path, h.at);
      // An entry made only of values the server did not give is no entry.
      const want = target ? (fill(h.entry, target) ?? undefined) : undefined;
      if (JSON.stringify(tables.at(-1)![h.at.at(-1)!]) === JSON.stringify(want)) continue;
      const next = edited(text, h.at, want);
      // A file with the same key twice is read at one and edited at the other. Writing that would strand an entry.
      if (JSON.stringify(found(next, h.at)) !== JSON.stringify(want)) throw new UserError(`${path} did not take the edit, so llmpick left it alone`);
      // The file can hold other providers' keys: keep its permissions, and replace it in one step.
      // A config that is a symlink to a file in a dotfiles folder stays one: the file it points at is replaced.
      const real = existsSync(path) ? realpathSync(path) : path;
      const mode = statSync(real, { throwIfNoEntry: false })?.mode ?? 0o600;
      const draft = `${real}.llmpick-${process.pid}`; // its own name, so two llmpicks cannot take each other's
      writeFileSync(draft, next, { mode: mode & 0o777 });
      renameSync(draft, real);
      changed = true;
    } catch (e) {
      problems.push(`${h.name}: ${(e as Error).message}`.replaceAll(homedir(), "~"));
    }
  }
  return { changed, problems };
}
