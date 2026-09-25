const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);
const PORT = 4488;
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const HOME = process.env.HOME;
const SHELL_NAMES = new Set(["zsh", "bash", "fish", "sh"]);

async function runQuiet(command, args, label) {
  try {
    const { stdout } = await run(command, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    console.error(`${label} failed:`, error.message.split("\n")[0]);
    return "";
  }
}

async function listProcesses() {
  const output = await runQuiet("ps", ["-axo", "pid=,ppid=,tty=,etime=,command="], "ps");
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, pid, ppid, tty, etime, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/) || [];
      return pid ? { pid: Number(pid), ppid: Number(ppid), tty, etime, command } : null;
    })
    .filter(Boolean);
}

async function currentDirectories(pids) {
  if (pids.length === 0) return {};
  const output = await runQuiet("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], "lsof");
  const directories = {};
  let currentPid = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) currentPid = Number(line.slice(1));
    else if (line.startsWith("n") && currentPid) directories[currentPid] = line.slice(1);
  }
  return directories;
}

async function gitBranch(directory) {
  try {
    const { stdout } = await run("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  } catch (error) {
    if (!/not a git repository/.test(error.message)) console.error(`git branch for ${directory} failed:`, error.message.split("\n")[0]);
    return "";
  }
}

// Each record: windowId, tabIndex, tty, title, busy, sessionId (iTerm2 only), visible screen text.
// Fields are separated by ASCII 31 and records by ASCII 30 because the screen text contains
// newlines and tabs. The "is running" guard stops osascript from launching a closed app.
const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

const TERMINAL_TABS_SCRIPT = `
set fieldSep to ASCII character 31
set recordSep to ASCII character 30
set output to ""
if application "Terminal" is running then
  tell application "Terminal"
    repeat with aWindow in windows
      set tabIndex to 0
      repeat with aTab in tabs of aWindow
        set tabIndex to tabIndex + 1
        set output to output & (id of aWindow) & fieldSep & tabIndex & fieldSep & (tty of aTab) & fieldSep & (custom title of aTab) & fieldSep & (busy of aTab) & fieldSep & fieldSep & (contents of aTab) & recordSep
      end repeat
    end repeat
  end tell
end if
return output`;

const ITERM_TABS_SCRIPT = `
set fieldSep to ASCII character 31
set recordSep to ASCII character 30
set output to ""
if application "iTerm2" is running then
  tell application "iTerm2"
    repeat with aWindow in windows
      set tabIndex to 0
      repeat with aTab in tabs of aWindow
        set tabIndex to tabIndex + 1
        repeat with aSession in sessions of aTab
          set output to output & (id of aWindow) & fieldSep & tabIndex & fieldSep & (tty of aSession) & fieldSep & (name of aSession) & fieldSep & (is processing of aSession) & fieldSep & (id of aSession) & fieldSep & (contents of aSession) & recordSep
        end repeat
      end repeat
    end repeat
  end tell
end if
return output`;

function screenTail(screen, lineCount) {
  return screen.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-lineCount).join("\n");
}

async function scriptedTabs() {
  const [terminalOutput, itermOutput] = await Promise.all([
    runQuiet("osascript", ["-e", TERMINAL_TABS_SCRIPT], "Terminal.app tab listing"),
    runQuiet("osascript", ["-e", ITERM_TABS_SCRIPT], "iTerm2 tab listing"),
  ]);
  const tabs = {};
  for (const [app, output] of [["Terminal", terminalOutput], ["iTerm2", itermOutput]]) {
    for (const record of output.split(RECORD_SEPARATOR).filter((item) => item.trim())) {
      const [windowId, tabIndex, tty, title, busy, sessionId, screen] = record.split(FIELD_SEPARATOR);
      tabs[tty.trim().replace("/dev/", "")] = { app, windowId: Number(windowId), tabIndex: Number(tabIndex), title, busy: busy === "true", sessionId, tail: screenTail(screen || "", 2) };
    }
  }
  return tabs;
}

function ownerApp(process, byPid) {
  let current = process;
  while (current && current.ppid > 1) {
    const parent = byPid[current.ppid];
    if (!parent) break;
    if (parent.command.includes("/Terminal.app/")) return "Terminal";
    if (parent.command.includes("/iTerm.app/")) return "iTerm2";
    if (parent.command.includes("/Visual Studio Code.app/")) return "VS Code";
    current = parent;
  }
  return current ? path.basename(current.command.split(" ")[0]) : "Unknown";
}

function foregroundProcess(shell, childrenOf) {
  const children = childrenOf[shell.pid] || [];
  return children.length > 0 ? children[children.length - 1] : null;
}

async function collectTerminals() {
  const [processes, tabs] = await Promise.all([listProcesses(), scriptedTabs()]);
  const byPid = {};
  const childrenOf = {};
  for (const process of processes) {
    byPid[process.pid] = process;
    (childrenOf[process.ppid] ||= []).push(process);
  }
  const shells = processes.filter((process) => {
    const name = path.basename(process.command.split(" ")[0]).replace(/^-/, "");
    return SHELL_NAMES.has(name) && process.tty.startsWith("ttys");
  });
  const directories = await currentDirectories(shells.map((shell) => shell.pid));
  const branches = {};
  await Promise.all(
    [...new Set(Object.values(directories))].map(async (directory) => {
      branches[directory] = await gitBranch(directory);
    })
  );
  return shells
    .map((shell) => {
      const tab = tabs[shell.tty] || {};
      const cwd = directories[shell.pid] || "";
      const foreground = foregroundProcess(shell, childrenOf);
      return {
        tty: shell.tty,
        pid: shell.pid,
        app: ownerApp(shell, byPid),
        title: tab.title || "",
        cwd,
        branch: branches[cwd] || "",
        command: foreground ? foreground.command : "",
        commandUptime: foreground ? foreground.etime : "",
        uptime: shell.etime,
        busy: Boolean(tab.busy),
        tail: tab.tail || "",
        windowId: tab.windowId || null,
        tabIndex: tab.tabIndex || null,
        sessionId: tab.sessionId || null,
      };
    })
    .sort((left, right) => {
      if (Boolean(left.windowId) !== Boolean(right.windowId)) return left.windowId ? -1 : 1;
      if (left.app !== right.app) return left.app.localeCompare(right.app);
      return (left.windowId || 0) - (right.windowId || 0) || (left.tabIndex || 0) - (right.tabIndex || 0) || left.tty.localeCompare(right.tty);
    });
}

// iTerm2 sessions are only addressable by walking windows > tabs > sessions.
function itermSessionScript(sessionId, action) {
  return `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          ${action}
        end if
      end repeat
    end repeat
  end repeat
end tell
error "Session ${sessionId} is no longer open"`;
}

async function scrollback(terminal) {
  const script = terminal.app === "iTerm2"
    ? itermSessionScript(terminal.sessionId, "return contents of aSession")
    : `tell application "Terminal" to return history of tab ${terminal.tabIndex} of window id ${terminal.windowId}`;
  const { stdout } = await run("osascript", ["-e", script], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.replace(/\s+$/, "").split("\n").slice(-300).join("\n");
}

async function focusTerminal(terminal) {
  if (terminal.app === "Terminal" && terminal.windowId) {
    const script = `tell application "Terminal"
  set targetWindow to window id ${terminal.windowId}
  set selected tab of targetWindow to tab ${terminal.tabIndex} of targetWindow
  set frontmost of targetWindow to true
  activate
end tell`;
    await run("osascript", ["-e", script]);
    return;
  }
  if (terminal.app === "iTerm2" && terminal.sessionId) {
    await run("osascript", ["-e", itermSessionScript(terminal.sessionId, "select aSession\n          select aTab\n          select aWindow\n          activate\n          return")]);
    return;
  }
  if (terminal.app === "VS Code") {
    await run("open", ["-a", "Visual Studio Code", terminal.cwd || HOME]);
    return;
  }
  throw new Error(`Cannot focus ${terminal.app} terminals`);
}

// The text travels as an osascript argument so quotes and control characters need no escaping.
async function sendInput(terminal, text, newline) {
  if (terminal.app === "iTerm2" && terminal.sessionId) {
    const action = 'tell aSession to write text (item 1 of argv) newline (item 2 of argv is "yes")\n          return';
    await run("osascript", ["-e", `on run argv\n${itermSessionScript(terminal.sessionId, action)}\nend run`, text, newline ? "yes" : "no"]);
    return;
  }
  if (terminal.app === "Terminal" && terminal.windowId) {
    if (!newline) throw new Error("Terminal.app only accepts whole lines");
    const script = `on run argv\ntell application "Terminal" to do script (item 1 of argv) in tab ${terminal.tabIndex} of window id ${terminal.windowId}\nend run`;
    await run("osascript", ["-e", script, text]);
    return;
  }
  throw new Error(`Cannot type into ${terminal.app} terminals`);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
  });
}

// Blocks DNS rebinding (Host check) and cross-site POSTs (Origin and JSON content type checks),
// since /api/send types into real terminals.
function isTrustedRequest(request) {
  if (!ALLOWED_HOSTS.has(request.headers.host)) return false;
  if (request.method !== "POST") return true;
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  return (request.headers["content-type"] || "").startsWith("application/json");
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  if (!isTrustedRequest(request)) return sendJson(response, 403, { error: "Forbidden" });
  try {
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(response);
    } else if (url.pathname === "/api/terminals") {
      sendJson(response, 200, { home: HOME, terminals: await collectTerminals() });
    } else if (url.pathname === "/api/scrollback") {
      const tty = url.searchParams.get("tty") || "";
      const terminal = (await collectTerminals()).find((item) => item.tty === tty);
      if (!terminal) return sendJson(response, 404, { error: `No terminal on ${tty}` });
      if (!terminal.windowId) return sendJson(response, 404, { error: `Preview is only available for Terminal.app and iTerm2 tabs, not ${terminal.app}` });
      sendJson(response, 200, { text: await scrollback(terminal) });
    } else if (url.pathname === "/api/focus" && request.method === "POST") {
      const body = parseJsonBody(await readBody(request));
      if (!body) return sendJson(response, 400, { error: "Invalid JSON body" });
      const { tty } = body;
      const terminal = (await collectTerminals()).find((item) => item.tty === tty);
      if (!terminal) return sendJson(response, 404, { error: `No terminal on ${tty}` });
      await focusTerminal(terminal);
      sendJson(response, 200, { ok: true });
    } else if (url.pathname === "/api/send" && request.method === "POST") {
      const body = parseJsonBody(await readBody(request));
      if (!body) return sendJson(response, 400, { error: "Invalid JSON body" });
      const { tty, text, newline } = body;
      if (typeof text !== "string" || text === "") return sendJson(response, 400, { error: "Nothing to send" });
      const terminal = (await collectTerminals()).find((item) => item.tty === tty);
      if (!terminal) return sendJson(response, 404, { error: `No terminal on ${tty}` });
      await sendInput(terminal, text, newline !== false);
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 404, { error: "Not found" });
    }
  } catch (error) {
    console.error(`${request.method} ${url.pathname} failed:`, error.message);
    sendJson(response, 500, { error: error.message });
  }
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    const address = `http://localhost:${PORT}`;
    console.log(`Terminal Viewer running at ${address}`);
    if (!process.argv.includes("--no-open")) {
      execFile("open", [address], (error) => error && console.error("Could not open browser:", error.message));
    }
  });
}

module.exports = { server, screenTail, ownerApp, foregroundProcess, isTrustedRequest };
