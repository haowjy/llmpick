# llmpick

Choose which local model is served on your machine, and see and stop what is serving.

llmpick is a small controller for local inference servers such as llama.cpp's `llama-server`.
You describe your engines and models once in a TOML file. llmpick starts one as a systemd user
service, shows what is running and where its memory is, and swaps to another when you ask.

```
  llmpick                                        GPU ██████████████░░ 21.2 GB of 24.0 GB
╭────────────────────────────────────────────────────────────────────────────────────────╮
│ Serving                                                                                │
│ ● inkling-nvfp4q8   serving for 4m   llamAmpere v0.7.5                                 │
│   http://127.0.0.1:18080/v1   llmpick/local in pi, opencode                            │
│   20.8 GB VRAM   0.8 GB RAM   10.3 GB file cache                                       │
╰────────────────────────────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────────────────────────────────╮
│ Profiles                                                                               │
│     profile           tok/s       engine                                               │
│ ❯ ● inkling-nvfp4q8   118         llamAmpere v0.7.5                                    │
│   · inkling-ai4       189 pub     llamAmpere v0.7.5                                    │
│   · inkling-sq20      41-70 pub   Strata latest                                        │
╰────────────────────────────────────────────────────────────────────────────────────────╯

  ↑↓ move   enter start   s stop   r restart   l logs   i details   / filter   q quit
```

## Why

- **It always knows what is serving.** The server runs as a systemd user unit, so llmpick asks
  systemd instead of keeping a PID file that goes stale. The server outlives the terminal or
  agent session that started it.
- **One model at a time.** Starting a profile stops the one that is serving first, because a
  single GPU usually holds one model.
- **Usable by scripts and coding agents.** Every action is a plain subcommand, and `status` and
  `ls` take `--json`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/haowjy/llmpick/main/install.sh | sh
llmpick init        # writes ~/.config/llmpick/profiles.toml for you to edit
```

The installer downloads one self-contained executable for your processor (x86-64 or ARM64)
from the [latest release](https://github.com/haowjy/llmpick/releases/latest), checks its
SHA-256, and puts it in `~/.local/bin`. Set `LLMPICK_INSTALL_DIR` to put it elsewhere, or
`LLMPICK_VERSION=v0.1.0` to pick a release. Run the same line again to update.

You need:

- Linux with a systemd user session (systemd 244 or later)
- at least one inference engine that serves HTTP and has a path that answers when it is ready
  (`GET /health` unless the engine's `health` setting names another)
- optional: `nvidia-smi` for GPU readings, and the Hugging Face `hf` CLI for `llmpick download`

To run from source instead, with [Bun](https://bun.sh) (developed on 1.4):

```bash
git clone https://github.com/haowjy/llmpick && cd llmpick
bun install
ln -s "$PWD/src/cli.ts" ~/.local/bin/llmpick
```

## Run a harness on the local model

llmpick keeps one model, `llmpick/local`, in your harness's own config. It always points at
whatever is serving, so the harness needs no change when you switch models:

```
llmpick start inkling-nvfp4q8
pi --model llmpick/local
opencode -m llmpick/local
```

Start a different profile and `llmpick/local` is that one. Stop, or let the server crash, and
the model is removed, so the harness says it is not found instead of calling a dead address.
`llmpick status` shows which harnesses have it.
In the harness's model picker the entry is labelled with the profile and its engine, for
example `inkling-nvfp4q8 <llamAmpere>`.

Harnesses are defined in your profiles file, not in llmpick: each `[harnesses.<name>]` block
names the config file, where the entry goes in it, and what the entry looks like. The starter
file from `llmpick init` has blocks for [pi](https://pi.dev) and
[opencode](https://opencode.ai) (version 2). llmpick edits only the files named there and
changes only its own entry in them: your other settings and comments are never touched, and
the entry is added in the file's own indentation. A file it cannot read as JSON is left alone and named in a warning. Delete a block and
that harness is left alone; add one to support another harness that keeps its models in a
JSON file.

**Upgrading from 0.2.0:** your profiles file has no harness blocks, so nothing is connected
until you add them. Copy the `[harnesses.…]` blocks from
[profiles.example.toml](profiles.example.toml) into `~/.config/llmpick/profiles.toml`, then
restart the model that is serving so its unit gets the stop hook.

## Use with a coding agent

Tell your agent:

> Run `llmpick agents` and follow it to manage local models.

That prints the guide for the installed version: which commands to run, how to read the JSON
output, and what llmpick does without asking. The same text is [AGENTS.md](AGENTS.md) in this
repository, or
`https://raw.githubusercontent.com/haowjy/llmpick/main/AGENTS.md` for an agent that has not
installed llmpick yet. To make it permanent, put that sentence in your own `AGENTS.md` or
`CLAUDE.md`.

## Use

```
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
llmpick agents              print the guide for coding agents
llmpick sync                point harnesses at what is serving (llmpick does this itself)
```

`<profile>` is an id, or words that match exactly one profile. `-y` skips confirmations.
Quitting the dashboard leaves the server running; `llmpick stop` stops it.

## Add an engine or a model

Edit `~/.config/llmpick/profiles.toml`. The comment at the top of the file lists every field. In short:

```toml
[engines.llamacpp]
name = "llama.cpp"
version = "b0000"
bin = "llama-server"

[profiles."my-model"]
engine = "llamacpp"
port = 8080
dir = "/path/to/models/my-model"
repo = "someone/My-Model-GGUF"
files = { weights = "my-model-Q4_K_M.gguf" }
args = ["-m", "{weights}", "--host", "127.0.0.1", "--port", "{port}"]
```

Then `llmpick show my-model` to check it, `llmpick download my-model` to fetch the files, and
`llmpick start my-model`.

Only facts that cannot be checked go in the file. Whether an engine is installed, files are
downloaded, or a profile is serving is worked out on every run.

## How it works

`llmpick start` runs the engine with `systemd-run --user` as the unit `llmpick-<id>.service`,
then polls the unit and the engine's health path until the server answers. Status comes from
`systemctl --user show`, logs from the journal, GPU figures from `nvidia-smi`, and the memory
split from the unit's cgroup. There is no daemon and no state file.

The design and code layout are in [.context/CONTEXT.md](.context/CONTEXT.md).

Reporting a problem and changing the code are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## Limits

- Linux and systemd only.
- Downloads come from Hugging Face only. Put files from elsewhere in the profile's `dir` yourself.
- There are no automated tests yet.

## License

MIT
