// {name} placeholders in values read from a config file.
//
// A template is a string, a list or a table, nested to any depth: a profile's
// argument list, a harness's entry. Filling it replaces each {name} with a
// value the caller supplies, by three rules:
//
//   "{id} <{engine}>"   text around a placeholder: the value is written into the text
//   "{context}"         a placeholder on its own: the value itself, keeping its type,
//                       so a number stays a number and a list a list
//   a null value        the caller has no such value: the key or list item is left
//                       out, a table that loses every key this way goes too, and
//                       inside text it is written as nothing
//
// A name is letters, digits, _ and -. Braces around anything else, such as JSON
// or a Jinja {{ expression }}, are ordinary text. There is no way to write a
// literal {name}.

const PLACEHOLDER = /\{([A-Za-z0-9_-]+)\}/g;
const ALONE = new RegExp(`^${PLACEHOLDER.source}$`);

/** What TOML calls a table and JSON an object. */
export const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every name the template uses, once each, so a config file can be checked when it is read. */
export function names(template: unknown): string[] {
  const found =
    typeof template === "string" ? [...template.matchAll(PLACEHOLDER)].map((m) => m[1])
    : Array.isArray(template) ? template.flatMap(names)
    : isTable(template) ? Object.values(template).flatMap(names)
    : [];
  return [...new Set(found)];
}

/**
 * The template with its placeholders filled from `values`. The result has the
 * template's shape, except where a placeholder on its own took a value of
 * another type. Throws on a name `values` does not have: check with `names`
 * when the config is read, so the mistake is reported against the file.
 */
export function fill<T>(template: T, values: Record<string, unknown>): T {
  const value = (name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`nothing to fill {${name}} with`);
    return values[name] ?? null;
  };
  const GONE = Symbol("left out");
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const alone = node.match(ALONE);
      return alone ? (value(alone[1]) ?? GONE) : node.replace(PLACEHOLDER, (_, name: string) => String(value(name) ?? ""));
    }
    if (Array.isArray(node)) return node.map(walk).filter((v) => v !== GONE);
    if (!isTable(node)) return node;
    const all = Object.entries(node).map(([k, n]) => [k, walk(n)] as const);
    const kept = all.filter(([, v]) => v !== GONE);
    return all.length && !kept.length ? GONE : Object.fromEntries(kept);
  };
  const filled = walk(template);
  return (filled === GONE ? null : filled) as T;
}
