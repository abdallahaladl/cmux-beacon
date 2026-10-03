// Live integration test — drives the plugin against the real cmux socket and
// reads back the actual sidebar state. Must be run inside a cmux workspace.
//
//   node test/live-test.mjs

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "cmux-beacon.js");
const COPY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cmux-beacon-live-")), "plugin.mjs");
fs.copyFileSync(SRC, COPY);

const WS = process.env.CMUX_WORKSPACE_ID;
if (!WS) {
  console.error("not inside a cmux workspace (CMUX_WORKSPACE_ID unset)");
  process.exit(2);
}

process.env.CMUX_BEACON_BIN = process.env.CMUX_BUNDLED_CLI_PATH || "cmux";
process.env.CMUX_BEACON_DONE_LINGER_MS = "0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sidebar() {
  try {
    return execFileSync(process.env.CMUX_BEACON_BIN, ["sidebar-state", "--workspace", WS], {
      encoding: "utf8",
    });
  } catch (e) {
    return String(e.stdout || e.message || e);
  }
}

function field(state, name) {
  const line = state.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.slice(name.length + 1) : "";
}

// cmux's own session hook may keep an `opencode` status pill alongside ours,
// so assert on our `task` pill rather than the raw status count.
function taskStatus(state) {
  const line = state.split("\n").find((l) => l.trim().startsWith("task="));
  return line ? line.trim().slice("task=".length) : "";
}

const { CmuxBeacon } = await import(`${COPY}?live=${Date.now()}`);
const hooks = await CmuxBeacon();
const SID = "live-test";
const ev = async (type, properties = {}) => {
  await hooks.event({ event: { type, properties } });
  await sleep(250);
};
const before = async (tool, args, callID) => {
  await hooks["tool.execute.before"]({ tool, sessionID: SID, callID }, { args });
  await sleep(250);
};
const after = async (tool, callID) => {
  await hooks["tool.execute.after"]({ tool, sessionID: SID, callID, args: {} }, { title: "", output: "", metadata: {} });
  await sleep(250);
};

let failures = 0;
function expect(name, got, want) {
  const ok = String(got).toLowerCase().includes(String(want).toLowerCase());
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures += 1;
}

await ev("session.created", { info: { id: SID } });
let s = sidebar();
expect("created clears progress", field(s, "progress"), "none");

await ev("session.status", { sessionID: SID, status: { type: "busy" } });
s = sidebar();
expect("busy progress", field(s, "progress"), "0.0");
expect("busy color", field(s, "color"), "#0ea5e9");
expect("busy status", taskStatus(s), "Working…");

await ev("todo.updated", {
  sessionID: SID,
  todos: [
    { content: "Scaffold project", status: "completed" },
    { content: "Build hero + nav", status: "in_progress" },
    { content: "Build sections", status: "pending" },
  ],
});
s = sidebar();
expect("todo label", field(s, "progress"), "Build hero");
expect("todo value", field(s, "progress"), "0.33");

await before("bash", { command: "npm run build" }, "l1");
s = sidebar();
expect("tool pill", s, "Running: npm run build");

await after("bash", "l1");
s = sidebar();
expect("revert pill", s, "Build hero");

await ev("permission.asked", { sessionID: SID, id: "p1" });
s = sidebar();
expect("permission pill", s, "Waiting for input");
expect("permission color", field(s, "color"), "#ff9500");

await ev("permission.replied", { sessionID: SID, id: "p1" });
s = sidebar();
expect("permission resolved", s, "Build hero");

await ev("todo.updated", {
  sessionID: SID,
  todos: [
    { content: "Scaffold project", status: "completed" },
    { content: "Build hero + nav", status: "completed" },
    { content: "Build sections", status: "completed" },
  ],
});
s = sidebar();
expect("done pill", s, "Done");
expect("done value", field(s, "progress"), "1.0");
expect("done color", field(s, "color"), "#12b3a6");

await ev("session.idle", { sessionID: SID });
await ev("session.deleted", { sessionID: SID });
s = sidebar();
expect("deleted clears progress", field(s, "progress"), "none");
expect("deleted clears status", taskStatus(s) || "none", "none");

console.log(failures === 0 ? "\nLIVE OK" : `\nLIVE FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
