// cmux-beacon — automatic sidebar progress, status and color for OpenCode.
//
// Loaded by OpenCode from ~/.config/opencode/plugins/ (or .opencode/plugins/).
// It mirrors a live OpenCode session into the cmux workspace sidebar, so the
// status pill, progress bar, step log and workspace color follow the agent
// without anyone running `cmux set-progress` / `set-status` / `log` by hand.
//
//   session start/busy  -> automatic progress bar (even before any todos)
//   OpenCode todo list  -> progress bar + `task` status pill + step log
//   tool execution      -> live `task` status pill (Editing x, Running y, …)
//   agent state         -> workspace color stripe + title tint
//                          (sky working · indigo thinking · amber needs input ·
//                           teal done · red error · gray paused · cleared idle)
//   permission/question -> waiting pill that outranks tool/todo labels
//   session lifecycle   -> busy / done / paused / cleared states
//
// No-op outside a cmux workspace (CMUX_WORKSPACE_ID unset).
//
// Environment:
//   CMUX_BEACON_BIN                override the cmux executable
//   CMUX_BEACON_DISABLE=1          disable the plugin entirely
//   CMUX_BEACON_WORKSPACE_COLOR=0  do not tint the workspace stripe/title
//   CMUX_BEACON_STATUS_KEY         sidebar status key (default: task)
//   CMUX_BEACON_DONE_LINGER_MS     keep "Done" this long before clearing
//                                  (default 12000; 0 keeps it until next work)
//   CMUX_BEACON_MAX_LABEL          max pill/progress label length (default 64)

import { spawn } from "node:child_process";

const INSTALLED_KEY = Symbol.for("cmux.beacon.plugin.installed");

const WORKSPACE = (process.env.CMUX_WORKSPACE_ID || "").trim();

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

const ENABLED = WORKSPACE.length > 0 && !envBool("CMUX_BEACON_DISABLE", false);

// Prefer the cmux build that owns this terminal, then the documented OpenCode
// hook override, then PATH. Spawning is best-effort and always detached.
const BIN =
  process.env.CMUX_BEACON_BIN ||
  process.env.CMUX_OPENCODE_CMUX_BIN ||
  process.env.CMUX_BUNDLED_CLI_PATH ||
  "cmux";

const STATUS_KEY = (process.env.CMUX_BEACON_STATUS_KEY || "task").trim() || "task";
const COLOR_WORKSPACE = envBool("CMUX_BEACON_WORKSPACE_COLOR", true);
const DONE_LINGER_MS = envInt("CMUX_BEACON_DONE_LINGER_MS", 12000);
const MAX_LABEL = Math.max(16, envInt("CMUX_BEACON_MAX_LABEL", 64));

const COLOR_ACTIVE = "#0ea5e9"; // sky
const COLOR_THINK = "#6366f1"; // indigo
const COLOR_DONE = "#12b3a6"; // teal
const COLOR_WAIT = "#ff9500"; // amber
const COLOR_ERROR = "#ff3b30"; // red
const COLOR_PAUSED = "#8e8e93"; // gray

// Automatic activity bar: shown while a session is working but has not
// produced a todo list yet, so the sidebar bar appears without the agent
// having to opt in. It creeps toward a ceiling and is replaced by exact todo
// progress (or cleared) as soon as the session changes phase.
const AUTO_START = 0.08;
const AUTO_CEIL = 0.92;
const AUTO_TICK_MS = 1600;
const AUTO_GROW = 0.06;

let lastStatus = "";
let lastProgress = "";
let lastColor = null;
let didInitialCleanup = false;
const sessions = new Map();

function cmux(args) {
  if (!ENABLED) return;
  try {
    const child = spawn(BIN, args, {
      stdio: "ignore",
      detached: true,
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
  } catch (_) {
    // cmux not reachable; everything here is best-effort.
  }
}

function clean(text, max = MAX_LABEL) {
  if (typeof text !== "string") return "";
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function baseName(p) {
  if (!p) return "file";
  return String(p).replace(/\\/g, "/").split("/").pop() || "file";
}

function commandSummary(command) {
  const lines = String(command || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  // Drop a leading `cd <dir> &&` so the actual command is what shows.
  return lines[0].replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, "");
}

function setColor(color) {
  if (!COLOR_WORKSPACE) return;
  if (!color) {
    if (lastColor === "") return;
    lastColor = "";
    cmux(["workspace-action", "--action", "clear-color", "--workspace", WORKSPACE]);
    return;
  }
  if (color === lastColor) return;
  lastColor = color;
  cmux([
    "workspace-action",
    "--action",
    "set-color",
    "--color",
    color,
    "--workspace",
    WORKSPACE,
  ]);
}

function setPill(label, color, icon) {
  label = clean(label);
  if (!label) return;
  setColor(color);
  const key = `${label}|${color}|${icon}`;
  if (key === lastStatus) return;
  lastStatus = key;
  cmux([
    "set-status",
    STATUS_KEY,
    label,
    "--icon",
    icon,
    "--color",
    color,
    "--priority",
    "90",
    "--workspace",
    WORKSPACE,
  ]);
}

function clearPill() {
  const had = lastStatus !== "";
  lastStatus = "";
  setColor(null);
  if (!had) return;
  cmux(["clear-status", STATUS_KEY, "--workspace", WORKSPACE]);
}

function setBar(value, label) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  const text = clean(label) || "Working";
  const key = `${v.toFixed(3)}|${text}`;
  if (key === lastProgress) return;
  lastProgress = key;
  cmux([
    "set-progress",
    v.toFixed(3),
    "--label",
    text,
    "--workspace",
    WORKSPACE,
  ]);
}

function clearBar() {
  if (lastProgress === "") return;
  lastProgress = "";
  cmux(["clear-progress", "--workspace", WORKSPACE]);
}

function logLine(message, level = "progress") {
  message = clean(message, 120);
  if (!message) return;
  cmux([
    "log",
    "--level",
    level,
    "--source",
    "opencode",
    "--workspace",
    WORKSPACE,
    "--",
    message,
  ]);
}

// Remove sidebar state left behind by a previous OpenCode run that exited
// before it could clean up. Runs once, on the first main session created.
function ensureInitialCleanup() {
  if (didInitialCleanup) return;
  didInitialCleanup = true;
  lastStatus = "";
  lastProgress = "";
  lastColor = "";
  cmux(["clear-progress", "--workspace", WORKSPACE]);
  cmux(["clear-status", STATUS_KEY, "--workspace", WORKSPACE]);
  if (COLOR_WORKSPACE) {
    cmux(["workspace-action", "--action", "clear-color", "--workspace", WORKSPACE]);
  }
}

function sessionState(id, info) {
  if (!id) return null;
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      child: false,
      busy: false,
      thinking: false,
      error: false,
      waitingQuestion: false,
      pendingPermission: 0,
      todos: [],
      stalePlan: false,
      toolLabel: null,
      running: new Map(),
      activity: "",
      autoValue: 0,
      autoTimer: null,
      doneTimer: null,
      lastLoggedStep: "",
    };
    sessions.set(id, s);
  }
  if (info) s.child = Boolean(info.parentID);
  return s;
}

function currentToolLabel(s) {
  if (s.running.size === 0) return null;
  let label = null;
  for (const value of s.running.values()) label = value;
  return label;
}

function stopAuto(s, reset = false) {
  if (!s) return;
  if (s.autoTimer) {
    clearInterval(s.autoTimer);
    s.autoTimer = null;
  }
  if (reset) {
    s.autoValue = 0;
    s.activity = "";
  }
}

function startAuto(s) {
  if (!s) return;
  if (s.autoValue < AUTO_START) s.autoValue = AUTO_START;
  setBar(s.autoValue, s.activity || "Working…");
  if (s.autoTimer) return;
  s.autoTimer = setInterval(() => {
    if (s.autoValue >= AUTO_CEIL) return;
    s.autoValue = Math.min(
      AUTO_CEIL,
      s.autoValue + (AUTO_CEIL - s.autoValue) * AUTO_GROW + 0.004
    );
    setBar(s.autoValue, s.activity || "Working…");
  }, AUTO_TICK_MS);
  if (typeof s.autoTimer.unref === "function") s.autoTimer.unref();
}

function clearDoneTimer(s) {
  if (s && s.doneTimer) {
    clearTimeout(s.doneTimer);
    s.doneTimer = null;
  }
}

function markIdle(s) {
  s.busy = false;
  s.thinking = false;
  // A fully completed plan becomes stale once the turn ends, so the next turn
  // does not read a leftover "Done" as the current state.
  s.stalePlan = s.todos.length > 0 && s.todos.every((t) => t.status === "completed");
  render(s);
}

function render(s) {
  if (!s || s.child) return;

  // Waiting states outrank everything else so the user always sees why the
  // agent stopped. The bar freezes at its current value meanwhile.
  if (s.waitingQuestion) {
    stopAuto(s);
    setPill("Waiting for your answer", COLOR_WAIT, "questionmark.circle");
    return;
  }
  if (s.pendingPermission > 0) {
    stopAuto(s);
    setPill("Waiting for input", COLOR_WAIT, "hand.raised.fill");
    return;
  }
  if (s.error) {
    stopAuto(s);
    setPill("Error", COLOR_ERROR, "exclamationmark.triangle.fill");
    return;
  }

  if (s.busy) {
    const hasActivePlan =
      s.todos.length > 0 && !s.todos.every((t) => t.status === "completed");
    if (hasActivePlan) {
      const total = s.todos.length;
      const done = s.todos.filter((t) => t.status === "completed").length;
      stopAuto(s);
      const current =
        s.todos.find((t) => t.status === "in_progress") ||
        s.todos.find((t) => t.status === "pending") ||
        null;
      const label = current ? current.content : `Step ${done}/${total}`;
      setBar(done / total, label);
      // The pill shows the live tool while one runs, otherwise the step.
      setPill(s.toolLabel || label, COLOR_ACTIVE, "gearshape");
      if (label !== s.lastLoggedStep) {
        logLine(`${done}/${total} · ${label}`, "progress");
        s.lastLoggedStep = label;
      }
      return;
    }

    // A plan completed earlier in this turn keeps its "Done" bar; one left
    // over from a previous turn is stale, so the fresh turn shows activity.
    if (s.todos.length > 0 && !s.stalePlan) {
      setBar(1, "Done");
      setPill("Done", COLOR_DONE, "checkmark.circle.fill");
      return;
    }

    const label = s.toolLabel || (s.thinking ? "Thinking…" : s.activity || "Working…");
    s.activity = label;
    const thinking = s.thinking && !s.toolLabel;
    setPill(label, thinking ? COLOR_THINK : COLOR_ACTIVE, thinking ? "sparkles" : "gearshape");
    startAuto(s);
    return;
  }

  // Idle.
  stopAuto(s, true);
  if (s.todos.length > 0) {
    if (s.todos.every((t) => t.status === "completed")) {
      setBar(1, "Done");
      setPill("Done", COLOR_DONE, "checkmark.circle.fill");
      if (DONE_LINGER_MS > 0) {
        clearDoneTimer(s);
        s.doneTimer = setTimeout(() => {
          s.doneTimer = null;
          if (
            !s.busy &&
            !s.error &&
            !s.waitingQuestion &&
            s.pendingPermission === 0
          ) {
            clearBar();
            clearPill();
          }
        }, DONE_LINGER_MS);
        if (typeof s.doneTimer.unref === "function") s.doneTimer.unref();
      }
    } else {
      setPill("Paused", COLOR_PAUSED, "pause.circle");
    }
    return;
  }

  clearBar();
  clearPill();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function sessionIdFrom(props) {
  return firstString(
    props.info && props.info.id,
    props.sessionID,
    props.sessionId,
    props.session_id,
    props.session && props.session.id
  );
}

function endSession(id) {
  const s = id ? sessions.get(id) : null;
  if (!s) return;
  const wasMain = !s.child;
  clearDoneTimer(s);
  stopAuto(s, true);
  sessions.delete(id);
  if (!wasMain) return;
  const other = [...sessions.values()].find((o) => !o.child);
  if (other) {
    render(other);
  } else {
    clearBar();
    clearPill();
  }
}

function handleEvent(event) {
  if (!event || !event.type) return;
  const props = event.properties || {};

  switch (event.type) {
    case "session.created": {
      const id = sessionIdFrom(props);
      if (!id) return;
      const info = props.info || {};
      if (info.time && info.time.archived) {
        endSession(id);
        return;
      }
      const s = sessionState(id, info);
      if (!s || s.child) return;
      ensureInitialCleanup();
      clearDoneTimer(s);
      s.busy = false;
      s.thinking = false;
      s.error = false;
      s.waitingQuestion = false;
      s.pendingPermission = 0;
      s.todos = [];
      s.stalePlan = false;
      s.toolLabel = null;
      s.running.clear();
      stopAuto(s, true);
      render(s);
      return;
    }

    case "session.updated": {
      const id = sessionIdFrom(props);
      if (!id) return;
      const info = props.info || {};
      if (info.time && info.time.archived) {
        endSession(id);
        return;
      }
      sessionState(id, info);
      return;
    }

    case "session.deleted":
      endSession(sessionIdFrom(props));
      return;

    case "session.status": {
      const id = sessionIdFrom(props);
      const s = sessionState(id);
      if (!s || s.child) return;
      const status = props.status;
      const type =
        typeof status === "string"
          ? status
          : firstString(status && status.type, status && status.state, status && status.status);
      if (type === "busy" || type === "retry") {
        clearDoneTimer(s);
        s.busy = true;
        s.error = false;
        render(s);
      } else if (type === "idle") {
        markIdle(s);
      }
      return;
    }

    case "session.idle": {
      const id = sessionIdFrom(props);
      const s = sessionState(id);
      if (!s || s.child) return;
      markIdle(s);
      return;
    }

    case "session.error": {
      const id = sessionIdFrom(props);
      const s = sessionState(id);
      if (!s || s.child) return;
      clearDoneTimer(s);
      s.busy = false;
      s.thinking = false;
      s.toolLabel = null;
      s.running.clear();
      s.error = true;
      render(s);
      return;
    }

    case "todo.updated": {
      const id = sessionIdFrom(props);
      const s = sessionState(id);
      if (!s || s.child) return;
      clearDoneTimer(s);
      s.todos = (Array.isArray(props.todos) ? props.todos : []).filter(
        (t) => t && t.status !== "cancelled"
      );
      s.stalePlan = false;
      s.lastLoggedStep = "";
      render(s);
      return;
    }

    case "message.part.updated": {
      const id = sessionIdFrom(props);
      const s = sessionState(id);
      if (!s || s.child) return;
      const part = props.part || {};
      if (part.type === "reasoning") {
        if (s.thinking && !s.toolLabel) return;
        s.thinking = true;
        clearDoneTimer(s);
        render(s);
      } else if (part.type === "tool" || part.type === "text") {
        if (!s.thinking) return;
        s.thinking = false;
        render(s);
      }
      return;
    }

    case "permission.updated":
    case "permission.asked": {
      const id = sessionIdFrom(props) || "unknown";
      const s = sessionState(id);
      if (!s || s.child) return;
      clearDoneTimer(s);
      s.pendingPermission += 1;
      render(s);
      return;
    }

    case "permission.replied": {
      const id = sessionIdFrom(props) || "unknown";
      const s = sessionState(id);
      if (!s || s.child) return;
      s.pendingPermission = Math.max(0, s.pendingPermission - 1);
      render(s);
      return;
    }

    case "question.asked": {
      const id = sessionIdFrom(props) || "unknown";
      const s = sessionState(id);
      if (!s || s.child) return;
      clearDoneTimer(s);
      s.waitingQuestion = true;
      render(s);
      return;
    }

    case "question.replied":
    case "question.rejected": {
      const id = sessionIdFrom(props) || "unknown";
      const s = sessionState(id);
      if (!s || s.child) return;
      s.waitingQuestion = false;
      render(s);
      return;
    }

    default:
      return;
  }
}

function toolLabelFor(tool, args) {
  const a = args || {};
  switch (tool) {
    case "bash": {
      const cmd = commandSummary(a.command);
      return cmd ? `Running: ${cmd}` : "Running a command";
    }
    case "edit":
    case "write":
    case "apply_patch":
    case "patch":
    case "multiedit":
      return `Editing ${baseName(a.filePath || a.path)}`;
    case "read":
      return `Reading ${baseName(a.filePath || a.path)}`;
    case "grep":
    case "glob":
    case "list":
      return "Searching the codebase";
    case "webfetch":
    case "fetch":
    case "websearch":
      return "Researching on the web";
    case "task":
      return "Delegating a subtask";
    case "skill":
      return a.name ? `Loading skill ${a.name}` : "Loading a skill";
    case "lsp":
    case "diagnostics":
      return "Checking the code";
    case "todowrite":
      return null;
    default:
      return tool ? `Using ${tool}` : null;
  }
}

function beforeTool(input, output) {
  const { tool, sessionID, callID } = input || {};
  const s = sessionState(sessionID);
  if (!s || s.child) return;
  if (tool === "todowrite") return; // the todo.updated event drives the bar
  clearDoneTimer(s);
  s.thinking = false;
  if (tool === "question") {
    s.waitingQuestion = true;
    render(s);
    return;
  }
  const label = toolLabelFor(tool, output && output.args);
  if (!label) return;
  if (callID) s.running.set(callID, label);
  else s.toolLabel = label;
  s.toolLabel = currentToolLabel(s) || label;
  s.activity = s.toolLabel;
  render(s);
}

function afterTool(input) {
  const { tool, sessionID, callID } = input || {};
  const s = sessionState(sessionID);
  if (!s || s.child) return;
  if (tool === "question") s.waitingQuestion = false;
  if (callID) s.running.delete(callID);
  s.toolLabel = currentToolLabel(s);
  if (!s.toolLabel) s.activity = "Working…";
  render(s);
}

export const CmuxBeacon = async () => {
  if (globalThis[INSTALLED_KEY]) return {};
  globalThis[INSTALLED_KEY] = true;
  if (!ENABLED) return {};

  return {
    event: async ({ event }) => {
      try {
        handleEvent(event);
      } catch (_) {
        // Never let sidebar bookkeeping break the agent loop.
      }
    },

    "tool.execute.before": async (input, output) => {
      try {
        beforeTool(input, output);
      } catch (_) {}
    },

    "tool.execute.after": async (input) => {
      try {
        afterTool(input);
      } catch (_) {}
    },
  };
};

export default CmuxBeacon;
