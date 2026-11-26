// The dashboard: what is serving on top, the profiles below, one key per action.
// The profile list and one profile's details share the same place; i switches between them.
// Lines put what matters first, so a narrow terminal cuts the least important text.

import { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import Spinner from "ink-spinner";
import { type Config, search } from "./config";
import { type ProfileStatus, type Snapshot, attach, endpoint, isLive, live, logCommand, missing, plan, serve, snapshot, stopAll, sync } from "./runtime";
import { COLUMNS, ago, detail, dim, engineLabel, harnessLine, memoryLine, mib, pad, phase, speed, stopQuestion, visible } from "./ui";

type Flash = { text: string; error: boolean };
type Ask = { text: string; yes: () => void };

/** A bordered region. One that may `clip` gives up its last rows when the terminal is too short. */
function Panel(props: { title: string; right?: string; color?: string; clip?: boolean; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.color ?? "gray"} paddingX={1} flexShrink={props.clip ? 1 : 0} overflow="hidden">
      <Box justifyContent="space-between" flexShrink={0}>
        <Text bold color={props.color}>{props.title}</Text>
        <Text dimColor>{props.right}</Text>
      </Box>
      {props.children}
    </Box>
  );
}

/** How full the card is, and how much of that is not llmpick's. Sheds its parts as the terminal narrows. */
function GpuMeter({ gpu, mine, room }: { gpu: Snapshot["gpu"]; mine: number; room: number }) {
  if (!gpu) return <Text dimColor>no GPU reading</Text>;
  const cells = room >= 70 ? 16 : 8;
  const full = Math.round((gpu.used / gpu.total) * cells);
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{room >= 96 && gpu.used > mine ? `${mib(gpu.used - mine)} used by other programs   ` : ""}GPU </Text>
      {room >= 44 ? <Text color={gpu.used / gpu.total > 0.9 ? "yellow" : "green"}>{"█".repeat(full)}</Text> : null}
      {room >= 44 ? <Text dimColor>{"░".repeat(cells - full)} </Text> : null}
      <Text>{mib(gpu.used)} of {mib(gpu.total)}</Text>
    </Text>
  );
}

/** A key hint. Every hint keeps its place; one that does nothing right now is dimmed. */
function Key({ k, what, off }: { k: string; what: string; off?: boolean }) {
  return (
    <Text dimColor={off}>
      <Text bold={!off}>{k}</Text>
      <Text dimColor>{`\u00a0${what}`}</Text>{"   "}
    </Text>
  );
}

function App({ cfg, first }: { cfg: Config; first: Snapshot }) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const [snap, setSnap] = useState(first);
  const [selected, setSelected] = useState(cfg.profiles[0].id);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(first.problems.length ? { text: `Harness not updated: ${first.problems[0]}`, error: true } : null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const working = useRef(false);
  const away = useRef(false);

  const refresh = async () => {
    if (away.current) return;
    const next = await snapshot(cfg);
    if (!away.current) setSnap(next);
  };
  useEffect(() => {
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  const matches = new Set(search(cfg, filter.split(/\s+/)).map((p) => p.id));
  const list = snap.profiles.filter((s) => matches.has(s.profile.id));
  const cur: ProfileStatus | undefined = list.find((s) => s.profile.id === selected) ?? list[0];
  const serving = live(snap);
  const todo = cur && plan(snap, cur);

  const say = (text: string, error = false) => setFlash({ text: text.split("\n")[0], error });
  /** How an action ended: its message, or the harness config that could not follow it. The panels already show that it worked. */
  const ended = (text: string, problems: string[]) => (problems.length ? void say(`Harness not updated: ${problems[0]}`, true) : text);

  /** Runs one action at a time, showing progress, then reports how it ended. */
  async function act(label: string, fn: () => Promise<string | void>) {
    if (working.current) return;
    working.current = true;
    setBusy(label);
    setFlash(null);
    try {
      const msg = await fn();
      if (msg) say(msg);
    } catch (e) {
      say((e as Error).message, true);
    }
    working.current = false;
    setBusy(null);
    await refresh();
  }

  /** Hands the terminal to a command, then takes it back. */
  async function handOff(cmd: string[], intro: string, pauseAfter: boolean): Promise<number> {
    let code = 1;
    away.current = true;
    await suspendTerminal(async () => {
      console.log(dim(intro));
      code = await attach(cmd);
      if (pauseAfter) {
        console.log(dim(`\n${code === 0 ? "Done" : `Exited with ${code}`}. Press any key to return to llmpick.`));
        await attach(["bash", "-c", "read -rsn1"]);
      }
    });
    away.current = false;
    await refresh();
    return code;
  }

  /** Enter and r: serve the profile, after whatever that takes first. */
  function start(s: ProfileStatus) {
    const p = s.profile;
    const todo = plan(snap, s);
    if (todo.kind === "blocked") return say(`Cannot start ${p.id}: ${todo.why}`, true);
    if (todo.kind === "download") {
      const cmd = todo.command;
      return setAsk({
        text: `${p.id} is not downloaded. Fetch ${missing(s).length} file${missing(s).length > 1 ? "s" : ""} from ${p.repo}?`,
        yes: async () => {
          const code = await handOff(cmd, `$ ${cmd.join(" ")}`, true);
          say(code === 0 ? `Downloaded ${p.id}. Enter starts it.` : `Download failed (exit ${code}).`, code !== 0);
        },
      });
    }
    const go = () =>
      act(`starting ${p.id}`, async () => {
        const problems = await serve(cfg, p, (stage, detail) => setBusy(detail ? `${stage} · ${detail}` : stage));
        return ended(`${p.id} is ready at ${endpoint(s.profile)}.`, problems);
      });
    const question = stopQuestion(p.id, todo.stops);
    if (question) setAsk({ text: question, yes: go });
    else go();
  }

  function stopServing() {
    if (!serving.length) return say("Nothing is serving.");
    const names = serving.map((s) => s.profile.id).join(", ");
    const stop = async () => {
      const { stopped, problems } = await stopAll(cfg);
      return ended(`Stopped ${stopped.join(", ")}.`, problems);
    };
    setAsk({ text: `Stop ${names}?`, yes: () => act(`stopping ${names}`, stop) });
  }

  function move(by: number) {
    if (!list.length) return;
    // From the previous value, so two arrow presses in one tick both count.
    setSelected((was) => {
      const i = Math.max(0, list.findIndex((s) => s.profile.id === was));
      return list[Math.min(list.length - 1, Math.max(0, i + by))].profile.id;
    });
  }

  useInput((input, key) => {
    if (away.current) return;
    if (ask) {
      setAsk(null);
      if (input === "y" || input === "Y") ask.yes();
      return;
    }
    if (filtering) {
      if (key.return || key.upArrow || key.downArrow) setFiltering(false);
      else if (key.escape) (setFiltering(false), setFilter(""));
      else if (key.backspace || key.delete) setFilter(filter.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setFilter(filter + input);
      return;
    }
    setFlash(null);
    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);
    if (key.escape) return detailOpen ? setDetailOpen(false) : setFilter("");
    if (input === "q") return exit();
    if (input === "/") return (setDetailOpen(false), setFiltering(true));
    if (input === "i") return setDetailOpen(!detailOpen);
    if (working.current) return;
    if (key.return && cur) return start(cur);
    if (input === "s") return stopServing();
    if (input === "r") return serving.length ? start(serving[0]) : say("Nothing is serving, so there is nothing to restart.");
    if (input === "l" && cur) handOff(logCommand(cur.profile.id, 200, true), `Output of ${cur.profile.id}. Ctrl-C returns to llmpick.`, false);
  });

  const idW = Math.max(COLUMNS.id.length, ...snap.profiles.map((s) => s.profile.id.length));
  const width = Math.min(columns, 120);
  // The list shows no state word: the marker and a dimmed row carry it, and details spell it out.
  // After the id come these columns, most important first. Each is as wide as its longest value and may have a
  // shorter form; one that still does not fit is left out with everything after it, so nothing is cut mid-word.
  const optional: { label: string; forms: ((s: ProfileStatus) => string)[]; dim?: true }[] = [
    { label: COLUMNS.speed, forms: [speed] },
    { label: COLUMNS.engine, forms: [engineLabel, (s) => s.profile.engine.name], dim: true },
  ];
  const shown: { label: string; text: (s: ProfileStatus) => string; w: number; dim?: true }[] = [];
  let room = width - 4 - (4 + idW);
  for (const c of optional) {
    if (snap.profiles.every((s) => !c.forms[0](s))) continue; // nothing to show under this label
    const fit = c.forms.map((text) => ({ text, w: Math.max(c.label.length, ...snap.profiles.map((s) => visible(text(s)))) })).find((f) => room >= 3 + f.w);
    if (!fit) break;
    shown.push({ label: c.label, dim: c.dim, ...fit });
    room -= 3 + fit.w;
  }
  const startable = !!cur && !isLive(cur) && todo?.kind !== "blocked";

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Box justifyContent="space-between" paddingX={2} flexShrink={0}>
        <Box flexShrink={0} marginRight={2}><Text bold>llmpick</Text></Box>
        <GpuMeter gpu={snap.gpu} mine={serving.reduce((sum, s) => sum + (s.vram ?? 0), 0)} room={width} />
      </Box>

      <Panel title="Serving" color={serving.length ? "green" : undefined}>
        {/* Three lines whether or not anything is serving, so the list below never moves. */}
        <Box flexDirection="column" minHeight={3}>
          {!serving.length ? <Text dimColor>Nothing is serving.</Text> : null}
          {serving.map((s) => (
            <Box key={s.profile.id} flexDirection="column">
              <Text wrap="truncate-end">
                {phase(s).dot} <Text bold>{s.profile.id}</Text>{"   "}{phase(s).label}
                <Text dimColor>{s.unit.since ? ` for ${ago(s.unit.since)}` : ""}{"   "}{engineLabel(s)}</Text>
              </Text>
              <Text wrap="truncate-end">{"  "}{endpoint(s.profile)}{"   "}{harnessLine(s)}</Text>
              <Text wrap="truncate-end">{"  "}{memoryLine(s)}</Text>
            </Box>
          ))}
        </Box>
      </Panel>

      {detailOpen && cur ? (
        <Panel title={cur.profile.id} clip>
          {detail(cur).map(([k, v]) => (
            <Box key={k} flexShrink={0}>
              <Box width={10} flexShrink={0}><Text dimColor>{k}</Text></Box>
              <Text wrap="wrap">{v}</Text>
            </Box>
          ))}
        </Panel>
      ) : (
        <Panel title="Profiles" right={filtering ? `/${filter}▏` : filter ? `/${filter}` : ""}>
          {!list.length ? <Text dimColor>No profile matches.</Text> : null}
          <Text dimColor wrap="truncate-end">
            {"    "}{pad(COLUMNS.id, idW)}{shown.map((c) => `   ${pad(c.label, c.w)}`).join("")}
          </Text>
          {list.map((s) => {
            const on = s === cur;
            return (
              <Text key={s.profile.id} wrap="truncate-end" dimColor={phase(s).faint}>
                <Text color="cyan">{on ? "❯" : " "}</Text> {phase(s).dot} <Text bold={on}>{pad(s.profile.id, idW)}</Text>
                {shown.map((c) => <Text key={c.label} dimColor={c.dim}>{`   ${pad(c.text(s), c.w)}`}</Text>)}
              </Text>
            );
          })}
        </Panel>
      )}

      <Box flexGrow={1} />
      <Box paddingX={2} height={1} flexShrink={0}>
        {ask ? (
          <Text wrap="truncate-end"><Text color="yellow" bold>{ask.text}</Text>{"   "}<Text bold>y</Text> yes{"   "}<Text bold>n</Text> no</Text>
        ) : busy ? (
          <Text wrap="truncate-end"><Spinner type="dots" /> {busy}</Text>
        ) : flash ? (
          <Text color={flash.error ? "red" : "green"} wrap="truncate-end">{flash.text}</Text>
        ) : null}
      </Box>
      <Box paddingX={2} flexShrink={0}>
        <Text wrap="wrap">
          <Key k="↑↓" what="move" />
          <Key k="enter" what="start" off={!startable} />
          <Key k="s" what="stop" off={!serving.length} />
          <Key k="r" what="restart" off={!serving.length} />
          <Key k="l" what="logs" />
          <Key k="i" what={detailOpen ? "list" : "details"} />
          <Key k="/" what="filter" />
          <Key k="q" what="quit" />
        </Text>
      </Box>
    </Box>
  );
}

export async function dashboard(cfg: Config): Promise<void> {
  const app = render(<App cfg={cfg} first={await sync(cfg)} />, { alternateScreen: true });
  await app.waitUntilExit();
  // Quitting the dashboard leaves the server running; say so.
  for (const s of live(await snapshot(cfg)))
    console.log(`${s.profile.id} is still serving at ${endpoint(s.profile)}. Stop it with: llmpick stop`);
}
