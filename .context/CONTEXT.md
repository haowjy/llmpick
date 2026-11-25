# llmpick design

llmpick chooses which local model is served on this machine, and shows and stops what is
serving. It is a thin controller: it starts nothing itself and remembers nothing.

## The three ideas

1. **systemd is the daemon.** Serving a profile means starting the systemd user unit
   `llmpick-<id>.service` with `systemd-run`. systemd supervises the process, keeps it alive
   after the shell or agent session that started it ends, and sends its output to the journal.
   llmpick has no state file: "what is serving" is always asked of systemd, so it cannot go
   stale. The bash version it replaced kept a PID file, which was wrong within hours.
2. **`~/.config/llmpick/profiles.toml` holds only what cannot be checked.** An engine is a program that serves
   models; a profile is one thing to serve (engine, model files, port, arguments). Versions,
   ports and speeds are written there by hand. Whether an engine is installed, files are
   downloaded or a profile is running is worked out on every run.
3. **One profile serves at a time.** The card holds one model, so starting a profile stops
   whatever llmpick is serving first. Restart is the same operation on the profile already
   serving.

## How a start works

Both front ends follow the same two steps, and both live in `runtime.ts`:

- `plan(snapshot, profile)` says what starting takes right now. It returns one of three
  answers: `blocked` (engine missing, or files missing with nowhere to fetch them), `download`
  (with the `hf` command to run), or `go` (with the ids that must stop first).
- `serve(config, profile)` does it: takes a fresh snapshot, stops what is serving, checks the
  port is free, runs `systemd-run`, then polls the unit and `GET /health` until the server
  answers. It throws with the last log lines if the server exits first.

The command line and the dashboard differ only in how they ask the question that `plan`
raises. Neither decides anything about starting on its own.

If the old server is stopped and the new one then fails to start, nothing is serving. That is
accepted: with one card there is no way to bring up the new one first.

## Code

About 850 lines of TypeScript run by Bun, in `src/`. Dependencies point one way:
`cli` and `tui` use `runtime` and `ui`; `ui` uses `runtime`'s types; `runtime` uses `config`.

| File | Lines | Owns |
|---|---:|---|
| `config.ts` | 120 | Reads and validates `profiles.toml`; fills `{port}`, `{dir}` and `{file}` in arguments; finds a profile from search words. |
| `runtime.ts` | 232 | Everything that touches the machine: `snapshot` (systemd units, health, GPU, files on disk), `plan`, `serve`, `stopAll`, and the log command. The only file that runs `systemctl`, `systemd-run`, `journalctl`, `nvidia-smi` or `ss`. |
| `ui.ts` | 80 | Wording shared by both front ends: a profile's state word, its detail rows, the confirmation question, number formats. |
| `cli.ts` | 163 | Argument parsing and the subcommands; prints text or JSON. |
| `tui.tsx` | 290 | The dashboard, built with Ink (React for terminals). Polls `snapshot` every 2 seconds. |

One poll costs three processes (`systemctl show` for all units at once, two `nvidia-smi`
queries) and one HTTP request per running profile.

## The dashboard

People open it for four things, most often first: see what is serving and its address, stop
it, serve something else, and occasionally look into one profile.

- **Top line:** how full the card is, and how much of that belongs to other programs.
- **Serving:** the one thing running: its address, how long it has been up, and where its
  memory is (VRAM, RAM, swap, and files the kernel has cached). Always three lines, so the list
  below does not move when a server starts or stops.
- **Profiles:** one row each: id, engine, headline speed, and whether it can be started.
- **Details** of the selected profile (files, folder, speeds, command) are hidden. `i` swaps
  the list for them in the same place, and `i` or `esc` swaps back.
- **Bottom two lines:** a question, progress or result, then the keys. Every key keeps its
  position; one that does nothing right now is dimmed.

Every line puts what matters first (id, then state, then speed, then engine), so a narrow
terminal cuts the least important text. The keys wrap onto more lines instead of being cut, and
the details panel is the one region that gives up rows when the terminal is short.

Colour is spent on state (serving, loading, crashed) and the selected row only. Quitting the
dashboard leaves the server running and says so on exit.

## Choices and their reasons

- **Bun and TypeScript, not Rust.** The tool is glue around other commands. Bun runs the
  source directly, so there is no build step.
- **Ink for the dashboard.** Layout, borders, key handling and handing the terminal to
  `journalctl` or `hf` come from the library. It brings about 50 packages; the alternative was
  roughly 150 lines of hand-written terminal drawing.
- **Plain subcommands beside the dashboard.** Agents and scripts use `status --json`, `start`
  and `stop`; they cannot drive a dashboard.
- **A script is not asked for confirmation.** Without a terminal, `start` switches models
  directly. It never downloads: that is `llmpick download`, so a script cannot fetch 14 GB by
  accident.
- **No daemon of our own.** One would add a single fixed endpoint that swaps models from the
  `model` field of each request. It can be built on `plan` and `serve` if that becomes wanted.

## Distribution

A release is one self-contained executable per processor, built with `bun build --compile`, so
a user needs neither Bun nor the source. Because the executable has no directory of its own to
keep files in, the profiles file lives in `~/.config/llmpick/`, and the starter profiles file
and the agent guide are compiled in (`llmpick init`, `llmpick agents`). Pushing a new `version`
in `package.json` to `main` makes the workflow tag and publish it; `install.sh` downloads the
latest release and checks its SHA-256.

## Known limits

- The health check is `GET /health` for every engine. An engine that answers elsewhere needs a
  per-engine setting; none installed needs one yet.
- If a profile is renamed in `profiles.toml` while it is serving, llmpick no longer sees its
  unit. `systemctl --user list-units 'llmpick-*'` does.
- A server started outside llmpick is shown only as a process on the GPU, and as an error when
  a profile wants its port.
- There are no tests. `LLMPICK_CONFIG` points llmpick at another profiles file, which is how to
  try start, switch and crash against a dummy engine without touching the GPU.
