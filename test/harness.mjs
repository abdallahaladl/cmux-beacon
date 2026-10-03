// Deterministic end-to-end tests for cmux-beacon.
//
// Drives the real plugin against a fake cmux binary and asserts the exact
// sidebar commands it emits across states, transitions and edge cases.
//
//   node test/harness.mjs

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, "..", "src", "cmux-beacon.js");
const FAKE_BIN = path.join(HERE, "fake-cmux.sh");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-beacon-"));
const PLUGIN_COPY = path.join(TMP, "plugin.mjs");
const CAPTURE = path.join(TMP, "capture.log");
const INSTALLED_KEY = Symbol.for("cmux.beacon.plugin.installed");

process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

fs.copyFileSync(PLUGIN_SRC, PLUGIN_COPY);
fs.chmodSync(FAKE_BIN, 0o755);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function contains(haystack, needle) {
  return String(haystack).includes(needle);
}

async function newPlugin(overrides = {}) {
  // Let any detached fake-cmux processes from the previous scenario drain
  // before we reset the capture file, so late writes cannot leak across runs.
  await sleep(700);
  fs.writeFileSync(CAPTURE, "");
  process.env.CMUX_WORKSPACE_ID = "WS-TEST";
  process.env.CMUX_BEACON_BIN = FAKE_BIN;
  process.env.CAPTURE_LOG = CAPTURE;
  process.env.CMUX_BEACON_DONE_LINGER_MS = "0";
  delete process.env.CMUX_BEACON_DISABLE;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete globalThis[INSTALLED_KEY];
  const mod = await import(`${PLUGIN_COPY}?v=${Date.now()}-${Math.random()}`);
  const hooks = await mod.CmuxBeacon();
  return hooks;
}

function readCalls() {
  const raw = fs.readFileSync(CAPTURE, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.split("\u001f").filter((v, i, arr) => !(i === arr.length - 1 && v === "")));
}

function lastCall(calls, verb) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i][0] === verb) return calls[i];
  }
  return null;
}

function lastStatus(calls) {
  const c = lastCall(calls, "set-status");
  return c ? c[2] : null;
}

function lastProgressValue(calls) {
  const c = lastCall(calls, "set-progress");
  return c ? Number(c[1]) : null;
}

function lastProgressLabel(calls) {
  const c = lastCall(calls, "set-progress");
  return c ? c[c.indexOf("--label") + 1] : null;
}

function lastColor(calls) {
  const c = lastCall(calls, "workspace-action");
  if (!c) return null;
  if (c.includes("clear-color")) return "(cleared)";
  const i = c.indexOf("--color");
  return i >= 0 ? c[i + 1] : null;
}

function makeDriver(hooks) {
  const SID = "S1";
  return {
    SID,
    async ev(type, properties = {}) {
      await hooks.event({ event: { type, properties } });
      await sleep(200);
    },
    async before(tool, args = {}, opts = {}) {
      const sessionID = opts.sessionID || SID;
      const callID = opts.callID || `c${Math.random().toString(36).slice(2)}`;
      await hooks["tool.execute.before"]({ tool, sessionID, callID }, { args });
      await sleep(200);
      return callID;
    },
    async after(tool, opts = {}) {
      const sessionID = opts.sessionID || SID;
      await hooks["tool.execute.after"](
        { tool, sessionID, callID: opts.callID, args: {} },
        { title: "", output: "", metadata: {} }
      );
      await sleep(200);
    },
  };
}

// ---------------------------------------------------------------------------
async function scenarioBasicFlow() {
  console.log("scenario: basic todo flow + waiting + done + cleanup");
  const hooks = await newPlugin();
  const d = makeDriver(hooks);

  await d.ev("session.created", { info: { id: d.SID } });
  let calls = readCalls();
  if (process.env.DEBUG) console.log("DEBUG basic calls:", JSON.stringify(calls));
  check("startup clears stale progress", !!lastCall(calls, "clear-progress"));
  check("startup clears stale status", !!lastCall(calls, "clear-status"));
  check("startup clears stale color", contains(lastCall(calls, "workspace-action") || [], "clear-color"));

  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  calls = readCalls();
  check("busy sets working pill", lastStatus(calls) === "Working…", lastStatus(calls));
  check("busy sets sky color", lastColor(calls) === "#0ea5e9", lastColor(calls));
  check("busy starts auto bar at 0.08", lastProgressValue(calls) === 0.08, String(lastProgressValue(calls)));

  const c1 = await d.before("bash", { command: "cd /Users/x && npm run build\nls" }, { callID: "c1" });
  calls = readCalls();
  check("bash pill strips leading cd", lastStatus(calls) === "Running: npm run build", lastStatus(calls));

  await d.ev("todo.updated", {
    sessionID: d.SID,
    todos: [
      { content: "Scaffold", status: "completed" },
      { content: "Build hero", status: "in_progress" },
      { content: "Sections", status: "pending" },
    ],
  });
  calls = readCalls();
  check("todo bar = 1/3", Math.abs(lastProgressValue(calls) - 0.3333) < 0.001, String(lastProgressValue(calls)));
  check("todo bar label = current step", lastProgressLabel(calls) === "Build hero", lastProgressLabel(calls));
  check("running tool outranks todo pill", lastStatus(calls) === "Running: npm run build", lastStatus(calls));

  await d.after("bash", { callID: c1 });
  calls = readCalls();
  check("after tool reverts pill to step", lastStatus(calls) === "Build hero", lastStatus(calls));

  await d.ev("permission.asked", { sessionID: d.SID, id: "perm1" });
  calls = readCalls();
  check("permission pill", lastStatus(calls) === "Waiting for input", lastStatus(calls));
  check("permission color amber", lastColor(calls) === "#ff9500", lastColor(calls));

  await d.ev("permission.replied", { sessionID: d.SID, id: "perm1" });
  calls = readCalls();
  check("permission cleared restores step", lastStatus(calls) === "Build hero", lastStatus(calls));

  await d.ev("todo.updated", {
    sessionID: d.SID,
    todos: [
      { content: "Scaffold", status: "completed" },
      { content: "Build hero", status: "completed" },
      { content: "Sections", status: "completed" },
    ],
  });
  calls = readCalls();
  check("all todos -> bar 1", lastProgressValue(calls) === 1, String(lastProgressValue(calls)));
  check("all todos -> done pill", lastStatus(calls) === "Done", lastStatus(calls));
  check("done color teal", lastColor(calls) === "#12b3a6", lastColor(calls));

  await d.ev("session.idle", { sessionID: d.SID });
  calls = readCalls();
  check("idle keeps done (linger 0)", lastStatus(calls) === "Done", lastStatus(calls));

  await d.ev("session.deleted", { sessionID: d.SID });
  calls = readCalls();
  check("delete clears progress", contains(lastCall(calls, "clear-progress") || [], "clear-progress"));
  check("delete clears status", !!lastCall(calls, "clear-status"));
  check("delete clears color", contains(lastCall(calls, "workspace-action") || [], "clear-color"));
}

async function scenarioThinkingAndTools() {
  console.log("scenario: thinking + auto bar + tool transitions (no todos)");
  const hooks = await newPlugin();
  const d = makeDriver(hooks);

  await d.ev("session.created", { info: { id: d.SID } });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  await d.ev("message.part.updated", { sessionID: d.SID, part: { type: "reasoning" } });
  let calls = readCalls();
  check("reasoning -> thinking pill", lastStatus(calls) === "Thinking…", lastStatus(calls));
  check("thinking color indigo", lastColor(calls) === "#6366f1", lastColor(calls));

  const c = await d.before("edit", { filePath: "/a/b/src/app.tsx" }, { callID: "e1" });
  calls = readCalls();
  check("edit pill", lastStatus(calls) === "Editing app.tsx", lastStatus(calls));
  check("tool color back to sky", lastColor(calls) === "#0ea5e9", lastColor(calls));

  await d.after("edit", { callID: c });
  calls = readCalls();
  check("after edit -> working", lastStatus(calls) === "Working…", lastStatus(calls));

  // Auto bar should advance past the start value over time.
  const before = lastProgressValue(calls);
  await sleep(1800);
  const after = lastProgressValue(readCalls());
  check("auto bar advances", after > before, `${before} -> ${after}`);

  await d.ev("session.idle", { sessionID: d.SID });
  calls = readCalls();
  check("idle no todos clears bar", contains(lastCall(calls, "clear-progress") || [], "clear-progress"));
  check("idle no todos clears pill", !!lastCall(calls, "clear-status"));
}

async function scenarioQuestionTool() {
  console.log("scenario: question tool");
  const hooks = await newPlugin();
  const d = makeDriver(hooks);
  await d.ev("session.created", { info: { id: d.SID } });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });

  const c = await d.before("question", {}, { callID: "q1" });
  let calls = readCalls();
  check("question pill", lastStatus(calls) === "Waiting for your answer", lastStatus(calls));
  check("question color amber", lastColor(calls) === "#ff9500", lastColor(calls));

  await d.after("question", { callID: c });
  calls = readCalls();
  check("question resolved -> working", lastStatus(calls) === "Working…", lastStatus(calls));
}

async function scenarioSubagentIsolation() {
  console.log("scenario: subagent isolation");
  const hooks = await newPlugin();
  const d = makeDriver(hooks);
  await d.ev("session.created", { info: { id: d.SID } });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  await d.before("bash", { command: "npm test" }, { callID: "m1" });
  const before = readCalls().length;

  await d.ev("session.created", { info: { id: "SUB", parentID: d.SID } });
  await d.ev("session.status", { sessionID: "SUB", status: { type: "busy" } });
  await d.ev("todo.updated", { sessionID: "SUB", todos: [{ content: "child noise", status: "in_progress" }] });
  await d.before("bash", { command: "echo child" }, { sessionID: "SUB", callID: "s1" });
  await d.ev("session.idle", { sessionID: "SUB" });
  const after = readCalls().length;

  check("subagent emits no sidebar calls", after === before, `${before} -> ${after}`);
}

async function scenarioErrorSticky() {
  console.log("scenario: error then idle stays error");
  const hooks = await newPlugin();
  const d = makeDriver(hooks);
  await d.ev("session.created", { info: { id: d.SID } });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  await d.ev("session.error", { sessionID: d.SID, error: { message: "boom" } });
  let calls = readCalls();
  check("error pill", lastStatus(calls) === "Error", lastStatus(calls));
  check("error color red", lastColor(calls) === "#ff3b30", lastColor(calls));

  await d.ev("session.idle", { sessionID: d.SID });
  calls = readCalls();
  check("idle after error stays error", lastStatus(calls) === "Error", lastStatus(calls));

  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  calls = readCalls();
  check("new turn clears error", lastStatus(calls) === "Working…", lastStatus(calls));
}

async function scenarioAutoResetOnNewTurn() {
  console.log("scenario: auto bar resets after a completed plan");
  const hooks = await newPlugin();
  const d = makeDriver(hooks);
  await d.ev("session.created", { info: { id: d.SID } });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  await d.ev("todo.updated", { sessionID: d.SID, todos: [{ content: "Only", status: "completed" }] });
  await d.ev("session.idle", { sessionID: d.SID });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  const calls = readCalls();
  const v = lastProgressValue(calls);
  check("fresh turn auto bar near start", v <= 0.2, String(v));
}

async function scenarioDuplicates() {
  console.log("scenario: duplicate events are idempotent");
  const hooks = await newPlugin();
  const d = makeDriver(hooks);
  await d.ev("session.created", { info: { id: d.SID } });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  const afterFirst = readCalls().length;
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  const afterSecond = readCalls().length;
  check("duplicate busy emits nothing", afterSecond === afterFirst, `${afterFirst} -> ${afterSecond}`);

  await d.ev("session.idle", { sessionID: d.SID });
  const afterIdle = readCalls().length;
  await d.ev("session.idle", { sessionID: d.SID });
  const afterIdle2 = readCalls().length;
  check("duplicate idle emits nothing", afterIdle2 === afterIdle, `${afterIdle} -> ${afterIdle2}`);
}

async function scenarioDisabledOutsideCmux() {
  console.log("scenario: no-op outside cmux");
  const hooks = await newPlugin({ CMUX_WORKSPACE_ID: "" });
  const keys = Object.keys(hooks);
  check("disabled returns no hooks", keys.length === 0, keys.join(","));
  check("disabled emits nothing", readCalls().length === 0);
}

async function scenarioMissingBinary() {
  console.log("scenario: missing cmux binary never throws");
  const hooks = await newPlugin({ CMUX_BEACON_BIN: path.join(HERE, "does-not-exist") });
  const d = makeDriver(hooks);
  let threw = false;
  try {
    await d.ev("session.created", { info: { id: d.SID } });
    await d.ev("session.status", { sessionID: d.SID, status: "busy" });
    await d.before("bash", { command: "ls" }, { callID: "x1" });
    await d.after("bash", { callID: "x1" });
    await d.ev("session.idle", { sessionID: d.SID });
  } catch (err) {
    threw = true;
  }
  check("missing binary stays silent", !threw);
  check("missing binary captured nothing", readCalls().length === 0);
}

async function scenarioUnknownSession() {
  console.log("scenario: permission/question without a session id");
  const hooks = await newPlugin();
  let threw = false;
  try {
    await hooks.event({ event: { type: "permission.asked", properties: { id: "p" } } });
    await sleep(60);
    await hooks.event({ event: { type: "permission.replied", properties: { id: "p" } } });
    await sleep(60);
    await hooks.event({ event: { type: "question.asked", properties: { id: "q" } } });
    await sleep(60);
    await hooks.event({ event: { type: "question.replied", properties: { id: "q" } } });
    await sleep(60);
  } catch (err) {
    threw = true;
  }
  check("unknown session does not throw", !threw);
  const calls = readCalls();
  check("unknown session still shows waiting pill", !!lastCall(calls, "set-status"));
}

async function scenarioConfigurable() {
  console.log("scenario: configurable status key + tiles");
  const hooks = await newPlugin({
    CMUX_BEACON_STATUS_KEY: "opencode",
    CMUX_BEACON_WORKSPACE_COLOR: "0",
  });
  const d = makeDriver(hooks);
  await d.ev("session.created", { info: { id: d.SID } });
  await d.ev("session.status", { sessionID: d.SID, status: { type: "busy" } });
  const calls = readCalls();
  const s = lastCall(calls, "set-status");
  check("custom status key", s && s[1] === "opencode", s && s[1]);
  check("workspace color disabled", !lastCall(calls, "workspace-action"), "unexpected color call");
}

// ---------------------------------------------------------------------------
const scenarios = [
  scenarioBasicFlow,
  scenarioThinkingAndTools,
  scenarioQuestionTool,
  scenarioSubagentIsolation,
  scenarioErrorSticky,
  scenarioAutoResetOnNewTurn,
  scenarioDuplicates,
  scenarioDisabledOutsideCmux,
  scenarioMissingBinary,
  scenarioUnknownSession,
  scenarioConfigurable,
];

// Run each scenario in its own process so a scenario that ends while a timer
// is live cannot leak sidebar calls (or a fake-cmux write) into the next one.
if (!process.env.ONLY && !process.env.CHILD) {
  const { spawnSync } = await import("node:child_process");
  let totalPass = 0;
  let totalFail = 0;
  for (const fn of scenarios) {
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ONLY: fn.name, CHILD: "1" },
      encoding: "utf8",
    });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    const m = /(\d+) passed, (\d+) failed/.exec(res.stdout || "");
    if (m) {
      totalPass += Number(m[1]);
      totalFail += Number(m[2]);
    } else {
      totalFail += 1;
    }
  }
  console.log(`\nTOTAL: ${totalPass} passed, ${totalFail} failed`);
  process.exit(totalFail === 0 ? 0 : 1);
}

for (const fn of scenarios) {
  if (process.env.ONLY && fn.name !== process.env.ONLY) continue;
  try {
    await fn();
  } catch (err) {
    fail += 1;
    failures.push(`${fn.name} threw: ${err && err.stack ? err.stack : err}`);
    console.log(`  ✗ ${fn.name} threw: ${err}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
