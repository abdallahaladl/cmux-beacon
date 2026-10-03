# cmux-beacon — agent instructions

Optional companion file. When loaded as an OpenCode instructions file, it tells
the agent how to keep cmux-beacon's sidebar indicators accurate.

You are running inside a cmux workspace. A plugin mirrors your OpenCode session
into the workspace sidebar automatically: the status pill updates as you use
tools, and the progress bar appears as soon as the session starts working — no
todo list required. It also mirrors your OpenCode todo list into the progress
bar and step log when one exists. It also tints the workspace color stripe and
title to match the live state (sky = working, indigo = thinking, amber = needs
input, teal = done, red = error, gray = paused). A finished task shows "Done",
then clears itself shortly after; a waiting permission or question outranks all
other states. You do NOT need to run `cmux set-progress`, `cmux set-status`,
`cmux log`, or `cmux workspace-action set-color` yourself.

To keep those indicators accurate without the user asking:

- For any task with more than one meaningful step, use the `todowrite` tool to
  lay out the plan before you start. Your todos then replace the automatic
  activity bar with exact progress.
- Keep exactly one todo item `in_progress` at a time and update the list as
  steps finish (mark them `completed`), so the sidebar progress bar stays live.
- Skip the todo list only for trivial single-step tasks.

The plugin is best-effort and silent outside cmux; tune it with
`CMUX_BEACON_DISABLE`, `CMUX_BEACON_WORKSPACE_COLOR`, `CMUX_BEACON_STATUS_KEY`,
`CMUX_BEACON_DONE_LINGER_MS` and `CMUX_BEACON_MAX_LABEL` when needed.

## Install as an instructions file

```sh
curl -fsSL https://raw.githubusercontent.com/abdallahaladl/cmux-beacon/main/docs/agent-instructions.md \
  -o ~/.config/opencode/cmux-beacon.md
```

Then reference it in `~/.config/opencode/opencode.json`:

```json
{
  "instructions": ["~/.config/opencode/cmux-beacon.md"]
}
```
