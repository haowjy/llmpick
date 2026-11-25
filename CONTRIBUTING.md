# Contributing to llmpick

## Report a problem

Open an issue at <https://github.com/haowjy/llmpick/issues> with:

- what you ran, what happened, and what you expected;
- the output of `llmpick status --json`;
- for a server that would not start or crashed, `llmpick logs <profile> -n 50`;
- the profile and its engine from your `profiles.toml` (remove anything private);
- `bun --version`, `systemctl --version | head -1`, and your distribution.

One problem per issue. Before opening one, check that the engine starts when you run the
command from `llmpick show <profile>` yourself: if it fails there too, the problem is the
engine or the profile, not llmpick.

## Change the code

Read [.context/CONTEXT.md](.context/CONTEXT.md) first. It explains the three ideas the code
rests on and what each file owns. The rules a change has to keep:

- **No state file.** What is serving is always read from systemd.
- **`runtime.ts` is the only file that touches the machine**: it alone runs `systemctl`,
  `systemd-run`, `journalctl`, `nvidia-smi` and `ss`.
- **`plan()` decides, `serve()` acts.** The command line and the dashboard only ask the
  question `plan()` raises. Do not add a start decision to either.
- **`profiles.toml` holds only what cannot be checked.** Do not add a field for something
  llmpick can find out by looking.
- **Keep it small.** Add a field, flag or mode when a real profile or user needs it, and remove
  what a change leaves unused.
- **Never commit your own profiles file** or anything else with machine paths or names.

To check a change:

```bash
bun install
bunx tsc                                   # must print no errors
LLMPICK_CONFIG=/tmp/test.toml src/cli.ts   # run against a profiles file of your own
```

There are no automated tests yet, so run what you changed. `LLMPICK_CONFIG` points llmpick at
another profiles file, which lets you try start, switch, crash and stop without loading a real
model: a dummy engine is any program that listens on the profile's port and answers
`GET /health` with 200. In the dashboard, check a narrow terminal (60 columns) as well as a wide
one.

## Release

Bump `version` in `package.json` and push to `main`. The workflow in
`.github/workflows/release.yml` builds the executables, tags the commit `v<version>` and
publishes a GitHub release with them. A push that does not change the version releases
nothing.

Open a pull request with what changed, why, and what you ran to check it. Update
`.context/CONTEXT.md`, `README.md` and `AGENTS.md` when the change makes them wrong.
