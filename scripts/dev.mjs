#!/usr/bin/env node
// `npm run dev`: the API server (tsx watch) and the Vite dev server side by
// side, each line prefixed with its name, both stopped together.
import { spawn } from "node:child_process";

const commands = [
  { name: "server", args: ["tsx", "watch", "src/server/index.ts"] },
  { name: "vite", args: ["vite"] },
];
const width = Math.max(...commands.map((c) => c.name.length));
const children = [];
let stopping = false;

// The TypeScript watcher and Vite each start processes of their own; on
// POSIX every child runs in its own process group so a signal reaches the
// whole tree.
const posix = process.platform !== "win32";

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (posix) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => process.exit(code), 300).unref();
}

for (const { name, args } of commands) {
  const prefix = `[${name.padEnd(width)}] `;
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
    shell: !posix,
    detached: posix,
  });
  const relay = (stream, out) => {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
    stream.on("end", () => {
      if (rest) out.write(prefix + rest + "\n");
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (!stopping) process.stderr.write(`${prefix}exited (${signal ?? code})\n`);
    stopAll(code ?? 0);
  });
  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stopAll(0));
