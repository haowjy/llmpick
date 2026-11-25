# llmpick for agents

llmpick chooses which local model is served on this machine. Use it to find, start and stop
local inference servers; do not launch an engine by hand, or llmpick will not see it.

This guide covers using llmpick and reading its output. `llmpick agents` prints it for the
installed version. The design, code layout and how to report a problem or contribute are in
the repository, <https://github.com/haowjy/llmpick>: `.context/CONTEXT.md` and
`CONTRIBUTING.md`.

## Use it

| To | Run |
|---|---|
| see what is serving and get its address | `llmpick status --json` |
| list what could be served | `llmpick ls --json` |
| inspect one profile's files and command | `llmpick show <profile>` |
| serve a profile | `llmpick start <profile>` |
| stop serving | `llmpick stop` |
| read the server's output | `llmpick logs [profile] -n 100` |
| fetch a profile's missing files | `llmpick download <profile> -y` |

`<profile>` is an id from `ls`, or words that match exactly one profile.

Behaviour to rely on:

- **Outside a terminal llmpick never asks.** `start` switches models at once and `download`
  starts at once. In a terminal, `-y` does the same.
- **`start` returns when the server answers**, not when the process launches. It waits up to 15
  minutes and exits non-zero, with the server's last output, if the server exits first.
- **`start` stops whatever llmpick is serving first.** One profile serves at a time. Before you
  start one, check `status`: someone or something may be using the model that is serving.
- **`start` never downloads.** If files are missing it fails and names the `download` command.
- **Every failure exits 1** with a one-line reason on stderr.
- **Do not run bare `llmpick` or `logs -f`.** The first opens an interactive dashboard and the
  second never returns.

## Read the output

`llmpick status --json`:

```json
{
  "serving": [{ "id": "…", "engine": "…", "state": "serving", "endpoint": "http://127.0.0.1:8080/v1",
                "pid": 1234, "since": 1795641495, "vram_mib": 21296 }],
  "crashed": ["…"],
  "gpu": { "used": 21710, "total": 24576, "apps": [{ "pid": 1234, "used": 21296, "name": "…" }] }
}
```

- `serving` is empty when nothing is serving. It holds at most one entry in normal use.
- `endpoint` is an OpenAI-compatible base URL. Use it only when `state` is `serving`.
- `since` is when the server started, in Unix seconds. `gpu` figures are MiB; `gpu` is `null`
  when there is no `nvidia-smi`.
- `crashed` lists profiles whose last run exited with an error. `llmpick logs <id>` shows why.
- `gpu.apps` includes programs llmpick did not start. A large entry that is not in `serving`
  means the card is in use by something else.

`llmpick ls --json` is a list of the same per-profile objects, one for every profile. `state`
is the same word the text output and the dashboard show:

| `state` | Meaning |
|---|---|
| `serving` | Running and answering its health check. Safe to send requests. |
| `loading` | Running but not answering yet. Wait. |
| `starting`, `stopping` | systemd is launching or ending it. |
| `available` | Not running; `llmpick start` would work. |
| `not downloaded` | Model files are missing; `llmpick download` fetches them. |
| `engine missing` | Its engine is not installed; `llmpick show` names what was looked for. |
| `crashed` | Its last run exited with an error. It can be started again. |

The plain-text `status` adds a memory line, for example
`20.8 GB VRAM   0.8 GB RAM   10.3 GB file cache`. VRAM is on the card. RAM is the server's own
memory; a large figure means part of the model is running on the CPU. "In swap" appears only
when memory has been pushed out, which is slow. File cache is the kernel holding the model file
after loading it and is not a problem.

## Add an engine or a model

Edit `~/.config/llmpick/profiles.toml` (`llmpick init` writes a starter one). The comment at its
top lists every field. Check the result with `llmpick show <id>`, which reports mistakes in the
file.
