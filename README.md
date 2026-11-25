# llmpick

Choose which local model is served on your machine, and see and stop what is serving.

llmpick is a small controller for local inference servers such as llama.cpp's `llama-server`.
You describe your engines and models once in a TOML file. llmpick starts one as a systemd user
service, shows what is running and where its memory is, and swaps to another when you ask.

```
  llmpick                                        GPU ██████████████░░ 21.2 GB of 24.0 GB
╭────────────────────────────────────────────────────────────────────────────────────────╮
│ Serving                                                                                │
│ ● inkling-5.4   serving for 4m   llamAmpere v0.7.5                                     │
│   http://127.0.0.1:18080/v1                                                            │
│   20.8 GB VRAM   0.8 GB RAM   10.3 GB file cache                                       │
╰────────────────────────────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────────────────────────────────╮
│ Profiles                                                                               │
│ ❯ ● inkling-5.4       serving          118 tok/s         llamAmpere v0.7.5             │
│   ○ inkling-4.4       not downloaded   189 tok/s pub     llamAmpere v0.7.5             │
│   ○ strata-sq20       engine missing   41-70 tok/s pub   Strata latest                 │
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

## Requirements

- Linux with a systemd user session
- [Bun](https://bun.sh) (developed on 1.4)
- At least one inference engine that serves HTTP and answers `GET /health` when ready
- Optional: `nvidia-smi` for GPU readings, and the Hugging Face `hf` CLI for `llmpick download`

## Install

```bash
git clone https://github.com/haowjy/llmpick
cd llmpick
bun install
cp profiles.example.toml profiles.toml     # then edit it
ln -s "$PWD/src/cli.ts" ~/.local/bin/llmpick
```

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
```

`<profile>` is an id, or words that match exactly one profile. `-y` skips confirmations.
Quitting the dashboard leaves the server running; `llmpick stop` stops it.

## Add an engine or a model

Edit `profiles.toml`. The comment at the top of the file lists every field. In short:

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
then polls the unit and `GET /health` until the server answers. Status comes from
`systemctl --user show`, logs from the journal, GPU figures from `nvidia-smi`, and the memory
split from the unit's cgroup. There is no daemon and no state file.

The design and code layout are in [.context/CONTEXT.md](.context/CONTEXT.md).

## Limits

- Linux and systemd only.
- The health check is `GET /health` for every engine.
- Downloads come from Hugging Face only. Put files from elsewhere in the profile's `dir` yourself.
- There are no automated tests yet.

## License

MIT
