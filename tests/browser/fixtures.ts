import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

interface BrowserJob {
  id: number;
  status: string;
  error: string | null;
  output_path: string;
}

interface AppFixture {
  url: string;
  heldCalls: () => number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  enqueue: (name: string) => Promise<number>;
  jobs: () => Promise<BrowserJob[]>;
  settings: () => Promise<Record<string, string>>;
  completeWhileStopped: (jobId: number) => void;
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function createApp(browserName: string): Promise<{ app: AppFixture; dispose: () => Promise<void> }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `subsmelt-browser-${browserName}-`));
  const configDirectory = path.join(directory, "config");
  const dataDirectory = path.join(directory, "data");
  const mediaDirectory = path.join(directory, "media");
  for (const target of [configDirectory, dataDirectory, mediaDirectory]) fs.mkdirSync(target);
  let calls = 0;
  const model = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ data: [{ id: "browser-model", object: "model" }] }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as { messages: { role: string; content: string }[] };
      if (payload.messages.some((message) => message.content.includes("subtitle content analyst"))) {
        response.end(
          JSON.stringify({
            id: "browser-analysis",
            object: "chat.completion",
            created: 0,
            model: "browser-model",
            choices: [
              { index: 0, message: { role: "assistant", content: "A fictional greeting." }, finish_reason: "stop" },
            ],
          }),
        );
        return;
      }
      calls++;
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelPort = (model.address() as net.AddressInfo).port;
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(configDirectory, "config.json"),
    JSON.stringify({
      settings: {
        llm_connections: JSON.stringify([
          {
            id: "browser",
            label: "Browser connection",
            provider: "local",
            endpoint: `http://127.0.0.1:${modelPort}/v1`,
            model: "browser-model",
            apiKey: "",
            enabled: true,
            order: 0,
          },
        ]),
        active_connection_id: "browser",
        auto_translate: "0",
        watch_enabled: "0",
        auto_scan_interval: "0",
        transcription_enabled: "0",
        gpu_shared: "0",
        chunk_size: "1",
        context_window: "0",
        request_timeout_s: "30",
      },
      tasks: [
        {
          id: 1,
          source_lang: "Automatic",
          target_lang: "French",
          lang_code: "fr",
          output_pattern: "{{name}}.fr.srt",
          enabled: 1,
          prompt_override: "",
          created_at: new Date().toISOString(),
        },
      ],
      _next_task_id: 2,
    }),
  );
  let child: ChildProcess | undefined;
  let logs = "";

  const stop = async () => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
    running.kill("SIGTERM");
    const killTimer = setTimeout(() => running.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  };

  const start = async () => {
    if (child) throw new Error("Browser test server is already started");
    logs = "";
    child = spawn(process.execPath, ["dist/server/index.js"], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOST: "127.0.0.1",
        PORT: String(port),
        NODE_ENV: "production",
        TZ: "UTC",
        CONFIG_DIR: configDirectory,
        DATA_DIR: dataDirectory,
        MEDIA_DIR: mediaDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-50_000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let launchError: Error | undefined;
    child.once("error", (error) => {
      launchError = error;
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Browser test server exited.\n${logs}`);
      const healthy = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) }).then(
        (response) => response.ok,
        () => false,
      );
      if (healthy) return;
      await delay(100);
    }
    throw new Error(`Browser test server did not become healthy.\n${logs}`);
  };

  const get = async <T>(route: string): Promise<T> => {
    const response = await fetch(`${url}${route}`);
    if (!response.ok) throw new Error(`${route} returned ${response.status}`);
    return response.json() as Promise<T>;
  };

  const app: AppFixture = {
    url,
    start,
    stop,
    heldCalls: () => calls,
    jobs: async () => (await get<{ jobs: BrowserJob[] }>("/api/jobs")).jobs,
    settings: () => get<Record<string, string>>("/api/settings"),
    enqueue: async (name) => {
      const srtPath = path.join(mediaDirectory, name);
      fs.writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:02,000\nA fictional greeting.\n");
      const response = await fetch(`${url}/api/jobs/translate-file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ srtPath, taskId: 1 }),
      });
      if (!response.ok) throw new Error(`Queue request failed.\n${await response.text()}`);
      return ((await response.json()) as { jobId: number }).jobId;
    },
    completeWhileStopped: (jobId) => {
      if (child) throw new Error("Stop the browser test server before editing its recovery fixture");
      const database = new Database(path.join(dataDirectory, "subsmelt.db"));
      try {
        database.prepare("UPDATE jobs SET status = 'done', completed_cues = 1, total_cues = 1 WHERE id = ?").run(jobId);
      } finally {
        database.close();
      }
    },
  };

  const dispose = async () => {
    await stop();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    await start();
    return { app, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export const test = base.extend<{ app: AppFixture }>({
  app: async ({ browserName }, use) => {
    const { app, dispose } = await createApp(browserName);
    try {
      await use(app);
    } finally {
      await dispose();
    }
  },
});
export { expect };
