#!/usr/bin/env node
"use strict";

const pty     = require("node-pty");
const WebSocket = require("ws");
const http    = require("http");
const os      = require("os");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");

// ─── Config ──────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const READONLY    = args.includes("--watch");
const PORT        = parseInt(process.env.PORT || "0"); // 0 = random
const SESSION_ID  = crypto.randomBytes(3).toString("hex").toUpperCase(); // e.g. A3F9C1
const SCROLLBACK  = 5000; // chars to buffer for late joiners
const ALT_SCREEN_BUFFER = 200000; // chars to retain while in alt screen

// Strip flags from command args
const cmdArgs = args.filter(a => !a.startsWith("--"));
const command = cmdArgs[0];
const commandArgs = cmdArgs.slice(1);

function resolveWindowsCommand(cmd) {
  if (process.platform !== "win32") return null;

  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map(ext => ext.toLowerCase());
  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  const hasPath = cmd.includes("\\") || cmd.includes("/") || path.isAbsolute(cmd);
  const ext = path.extname(cmd).toLowerCase();

  const tryResolve = (candidate) => {
    for (const dir of pathDirs) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
    return null;
  };

  if (hasPath) {
    const base = path.resolve(cmd);
    if (fs.existsSync(base)) return base;
    if (!ext) {
      for (const pe of pathExt) {
        const withExt = base + pe;
        if (fs.existsSync(withExt)) return withExt;
      }
    }
    return null;
  }

  if (ext) return tryResolve(cmd);

  for (const pe of pathExt) {
    const found = tryResolve(cmd + pe);
    if (found) return found;
  }

  return null;
}

function quoteCmdArg(arg) {
  if (arg === "") return '""';
  if (/[\s"]/.test(arg)) return `"${arg.replace(/"/g, '""')}"`;
  return arg;
}

function buildCmdLine(cmd, cmdArgs) {
  return [cmd, ...cmdArgs].map(quoteCmdArg).join(" ");
}


if (!command) {
  console.error("\nUsage: shareterm <command> [args...] [--watch]\n");
  console.error("  shareterm uvicorn app:app --reload");
  console.error("  shareterm npm start");
  console.error("  shareterm bash                  # share a shell");
  console.error("  shareterm npm start --watch     # read-only mode\n");
  process.exit(1);
}

// ─── State ───────────────────────────────────────────────────────────────────

let scrollbackBuf = ""; // ring buffer of recent output
let connectedClients = new Set();
let shellProcess = null;
let ptyCols = null;
let ptyRows = null;
let altScreenBuf = "";
let altEscCarry = "";
let inAltScreen = false;

const ALT_MODE_RE = /\x1b\[\?(1049|47|1047)([hl])/g;
const ALT_CARRY_MAX = 32;

function updatePtySize(cols, rows) {
  const nextCols = Math.max(2, Number(cols) || 80);
  const nextRows = Math.max(2, Number(rows) || 24);
  ptyCols = nextCols;
  ptyRows = nextRows;
  if (shellProcess) shellProcess.resize(nextCols, nextRows);
}

function nudgePtyResize() {
  if (!shellProcess) return;
  const cols = Math.max(2, ptyCols || 80);
  const rows = Math.max(2, ptyRows || 24);
  const nudgeCols = Math.max(1, cols - 1);
  const nudgeRows = Math.max(1, rows - 1);
  // Force a SIGWINCH so TUIs repaint on new viewer connect.
  shellProcess.resize(nudgeCols, nudgeRows);
  setTimeout(() => {
    if (shellProcess) shellProcess.resize(cols, rows);
  }, 80);
}

function appendScrollback(data) {
  scrollbackBuf += data;
  if (scrollbackBuf.length > SCROLLBACK) {
    scrollbackBuf = scrollbackBuf.slice(scrollbackBuf.length - SCROLLBACK);
  }
}

function appendAltScreen(data) {
  altScreenBuf += data;
  if (altScreenBuf.length > ALT_SCREEN_BUFFER) {
    altScreenBuf = altScreenBuf.slice(altScreenBuf.length - ALT_SCREEN_BUFFER);
  }
}

function trackAltScreen(data) {
  const combined = altEscCarry + data;
  let entered = false;
  let exited = false;
  ALT_MODE_RE.lastIndex = 0;
  let match;
  while ((match = ALT_MODE_RE.exec(combined)) !== null) {
    if (match[2] === "h") {
      inAltScreen = true;
      entered = true;
    } else {
      inAltScreen = false;
      exited = true;
    }
  }

  altEscCarry = combined.slice(-ALT_CARRY_MAX);

  if (inAltScreen || entered) {
    appendAltScreen(data);
  }

  if (exited) {
    altScreenBuf = "";
  }
}

// ─── HTTP server (serves phone UI) ───────────────────────────────────────────

const clientHtml = fs.readFileSync(path.join(__dirname, "viewer.html"));

const httpServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(clientHtml);
  }
  res.writeHead(404); res.end();
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws) => {
  let authed = false;

  ws.send(JSON.stringify({ type: "challenge", readonly: READONLY }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Auth
      if (msg.type === "auth") {
        if (msg.token !== SESSION_ID) {
          ws.send(JSON.stringify({ type: "auth_fail" }));
          return ws.close();
        }
        authed = true;
        connectedClients.add(ws);
        ws.send(JSON.stringify({ type: "auth_ok", readonly: READONLY }));
        // Send scrollback so phone sees existing output immediately
        const initial = (inAltScreen && altScreenBuf) ? altScreenBuf : scrollbackBuf;
        if (initial) {
          ws.send(JSON.stringify({ type: "output", data: initial }));
        }
        nudgePtyResize();
        broadcastViewerCount();
        return;
      }

      if (!authed) return;

      // Input from phone → shell
      if (msg.type === "input" && !READONLY && shellProcess) {
        shellProcess.write(msg.data);
      }

      // Resize
      if (msg.type === "resize" && shellProcess) {
        updatePtySize(msg.cols || 80, msg.rows || 24);
      }

      if (msg.type === "ready" && shellProcess) {
        nudgePtyResize();
      }

    } catch (_) {}
  });

  ws.on("close", () => {
    connectedClients.delete(ws);
    broadcastViewerCount();
  });
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of connectedClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

function broadcastViewerCount() {
  broadcast({ type: "viewers", count: connectedClients.size });
}

// ─── Start server + spawn process ────────────────────────────────────────────

httpServer.listen(PORT, () => {
  const actualPort = httpServer.address().port;

  // Get local IPs
  const ips = [];
  Object.values(os.networkInterfaces()).forEach(addrs => {
    addrs.forEach(a => { if (a.family === "IPv4" && !a.internal) ips.push(a.address); });
  });

  // Spawn the wrapped process
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;

  let spawnCommand = command;
  let spawnArgs = commandArgs;
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand(command) || command;
    const resolvedExt = path.extname(resolved).toLowerCase();
    if (resolvedExt === ".cmd" || resolvedExt === ".bat") {
      spawnCommand = process.env.ComSpec || "cmd.exe";
      const commandLine = buildCmdLine(resolved, commandArgs);
      // Pass a single string so node-pty doesn't escape embedded quotes.
      spawnArgs = `/d /s /c "${commandLine}"`;
    } else {
      spawnCommand = resolved;
    }
  }

  shellProcess = pty.spawn(spawnCommand, spawnArgs, {
    name: "xterm-256color",
    cols, rows,
    cwd: process.cwd(),
    env: process.env,
  });

  updatePtySize(cols, rows);

  shellProcess.on("data", (data) => {
    // Write to local terminal (transparent)
    process.stdout.write(data);
    trackAltScreen(data);
    // Buffer + stream to phone
    if (!inAltScreen) {
      appendScrollback(data);
    }
    broadcast({ type: "output", data });
  });

  shellProcess.on("exit", (code) => {
    broadcast({ type: "exit", code });
    process.exit(code ?? 0);
  });

  // Forward local keyboard → shell
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    shellProcess.write(data.toString());
  });

  // Handle local terminal resize
  process.stdout.on("resize", () => {
    updatePtySize(process.stdout.columns, process.stdout.rows);
  });

  // SIGINT passthrough
  process.on("SIGINT", () => {});

  // ─── Print the pairing banner ────────────────────────────────────────────
  // Use a brief delay so the process output doesn't collide with the banner
  setTimeout(() => {
    const url = ips.length ? `http://${ips[0]}:${actualPort}` : `http://localhost:${actualPort}`;
    printBanner(SESSION_ID, url, ips, actualPort, READONLY);
    // Some tools clear the screen on startup; reprint a short line afterward.
    setTimeout(() => {
      printPairingLine(SESSION_ID, url, READONLY);
    }, 1200);
  }, 200);
});

function printPairingLine(code, url, readonly) {
  const mode = readonly ? "WATCH" : "PAIR";
  process.stderr.write(`Shareterm ${mode} code: ${code}  URL: ${url}\n`);
}

function printBanner(code, url, ips, port, readonly) {
  const B = "\x1b[1m", R = "\x1b[0m", G = "\x1b[32m", C = "\x1b[36m", Y = "\x1b[33m", D = "\x1b[2m";

  process.stderr.write(`\n`);
  process.stderr.write(`${D}┌─────────────────────────────────────────────────┐${R}\n`);
  process.stderr.write(`${D}│${R}  ${B}${G}▶ SHARETERM${R}  ${D}session active${R}${readonly ? `  ${Y}[WATCH ONLY]${R}` : ""}${" ".repeat(readonly ? 3 : 14)}${D}│${R}\n`);
  process.stderr.write(`${D}├─────────────────────────────────────────────────┤${R}\n`);
  process.stderr.write(`${D}│${R}  ${D}Pairing Code${R}                                    ${D}│${R}\n`);
  process.stderr.write(`${D}│${R}  ${B}${C}  ${code.split("").join("  ")}  ${R}${" ".repeat(33 - code.length * 3)}${D}│${R}\n`);
  process.stderr.write(`${D}│${R}                                                 ${D}│${R}\n`);
  process.stderr.write(`${D}│${R}  ${D}Open on your phone:${R}                            ${D}│${R}\n`);
  ips.forEach(ip => {
    const u = `http://${ip}:${port}`;
    process.stderr.write(`${D}│${R}  ${G}→${R} ${u}${" ".repeat(Math.max(1, 47 - u.length))}${D}│${R}\n`);
  });
  process.stderr.write(`${D}│${R}                                                 ${D}│${R}\n`);
  process.stderr.write(`${D}│${R}  ${D}Viewers connected: ${R}${B}0${R}                             ${D}│${R}\n`);
  process.stderr.write(`${D}└─────────────────────────────────────────────────┘${R}\n`);
  process.stderr.write(`\n`);
}
