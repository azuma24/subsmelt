#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const string = { type: "string" };
const flag = { type: "boolean" };
const inputOptions = {
  file: string,
  url: string,
  profile: string,
  model: string,
  language: string,
  format: string,
  translate: flag,
  review: flag,
  note: flag,
  "audio-stream": string,
  "audio-only": flag,
  overwrite: flag,
  force: flag,
};
const commands = {
  plan: inputOptions,
  submit: { ...inputOptions, key: string },
  status: {},
  wait: { timeout: string, interval: string },
  cancel: {},
  download: { output: string, note: flag },
  approve: { edit: string, targets: string, revision: string },
};
const work = "/api/transcribe/work";
class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function integer(value, label, minimum, maximum) {
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum)
    throw new CliError(`${label} must be an integer between ${minimum} and ${maximum}`);
  return Number(value);
}

async function main([command, ...args]) {
  if (command === "--help" || command === "help") {
    return {
      usage: "subsmelt.mjs <plan|submit|status|wait|cancel|download|approve> [options]",
      commands: {
        plan: "--file SERVER_PATH | --url URL [--profile ID] [--model MODEL] [--language LANG] [--format srt|vtt|ass|txt] [--review] [--note] [--translate] [--audio-stream INDEX] [--audio-only] [--overwrite] [--force]",
        submit: "Same options as plan, plus --key IDEMPOTENCY_KEY",
        status: "[WORK_ID]",
        wait: "WORK_ID [--timeout SECONDS] [--interval SECONDS]",
        cancel: "WORK_ID",
        download: "WORK_ID [--note] [--output PATH]",
        approve: "WORK_ID [--edit PATH --revision SHA256] [--targets ID,ID]",
      },
    };
  }
  if (!Object.hasOwn(commands, command)) throw new CliError("Choose a command. Run with --help for usage");
  const { values, positionals } = parseArgs({
    args,
    options: { ...commands[command], server: string },
    allowPositionals: true,
  });
  const inputCommand = command === "plan" || command === "submit";
  const id = positionals[0];
  if (inputCommand ? positionals.length : positionals.length > 1 || (command !== "status" && !id)) {
    throw new CliError(inputCommand ? "Use --file or --url to provide input" : "Expected a work ID");
  }
  let server;
  try {
    server = new URL(values.server ?? process.env.SUBSMELT_URL ?? "http://localhost:3000");
    if (
      !["http:", "https:"].includes(server.protocol) ||
      server.username ||
      server.password ||
      server.search ||
      server.hash
    )
      throw new Error();
  } catch {
    throw new CliError("Set --server or SUBSMELT_URL to a valid HTTP(S) URL");
  }
  const base = server.href.replace(/\/+$/, "");
  const authFile = process.env.SUBSMELT_AUTHORIZATION_FILE;
  const authorization = authFile
    ? (await readFile(authFile, "utf8")).trim()
    : process.env.SUBSMELT_AUTHORIZATION?.trim();

  async function request(endpoint, { method = "GET", body, key, raw = false, timeoutMs = 30_000 } = {}) {
    const response = await fetch(base + endpoint, {
      method,
      redirect: "error",
      headers: {
        ...(authorization && { Authorization: authorization }),
        ...(body && { "Content-Type": "application/json" }),
        ...(key && { "Idempotency-Key": key }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new CliError(failure.error || `Server returned HTTP ${response.status}`, 1);
    }
    return raw ? response : response.json();
  }

  if (inputCommand) {
    if (Boolean(values.file) === Boolean(values.url)) throw new CliError("Provide one of --file or --url");
    if (values.format && !["srt", "vtt", "ass", "txt"].includes(values.format))
      throw new CliError("Unknown output format");
    const audioStreamIndex =
      values["audio-stream"] === undefined
        ? undefined
        : integer(values["audio-stream"], "Audio stream", 0, 2_147_483_647);
    const input = {
      kind: values.file ? "file" : "url",
      input: values.file ?? values.url,
      request: {
        profileId: values.profile,
        model: values.model,
        language: values.language,
        outputFormat: values.format,
        postAction: values.translate ? "transcribe_and_translate" : undefined,
        review: values.review,
        exportNote: values.note,
        audioStreamIndex,
        audioOnlyUpload: values["audio-only"],
        overwrite: values.overwrite,
        forceRecognition: values.force,
      },
    };
    return request(command === "plan" ? `${work}/plan` : work, {
      method: "POST",
      body: command === "plan" ? input : { inputs: [input] },
      key: values.key,
    });
  }

  const endpoint = id ? `${work}/${encodeURIComponent(id)}` : work;
  if (command === "status") return request(endpoint);
  if (command === "cancel") return request(`${endpoint}/cancel`, { method: "POST" });
  if (command === "approve") {
    if (values.edit && !values.revision)
      throw new CliError("--edit requires the revision from the downloaded transcript");
    const revision = values.revision ?? (await request(`${endpoint}/review`)).revision;
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new CliError("Invalid transcript revision");
    const content = values.edit ? await readFile(values.edit, "utf8") : undefined;
    const targetIds =
      values.targets === undefined
        ? undefined
        : values.targets === ""
          ? []
          : values.targets.split(",").map((value) => integer(value.trim(), "Target ID", 1, Number.MAX_SAFE_INTEGER));
    return request(`${endpoint}/review`, { method: "POST", body: { revision, content, targetIds } });
  }
  if (command === "download") {
    const response = await request(`${endpoint}/download${values.note ? "?format=note" : ""}`, { raw: true });
    const content = await response.text();
    const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
    const revision = response.headers.get("x-transcript-revision") ?? undefined;
    if (values.output) {
      await writeFile(values.output, content, { flag: "wx", mode: 0o600 });
      return { id, filename, revision, output: values.output, bytes: Buffer.byteLength(content) };
    }
    return { id, filename, revision, content };
  }
  const deadline = Date.now() + 1000 * integer(values.timeout ?? "1800", "Timeout", 1, 86400);
  const interval = 1000 * integer(values.interval ?? "2", "Interval", 1, 60);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CliError("Wait timed out", 4);
    const result = await request(endpoint, { timeoutMs: Math.min(remaining, 30_000) }).catch((error) => {
      if (Date.now() >= deadline) throw new CliError("Wait timed out", 4);
      throw error;
    });
    if (result.status === "succeeded") return result;
    if (result.status === "failed" || result.status === "cancelled") {
      process.exitCode = 3;
      return result;
    }
    if (result.status === "needs_review") {
      process.exitCode = 5;
      return result;
    }
    await sleep(Math.max(0, Math.min(interval, deadline - Date.now())));
  }
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.exitCode = error.exitCode ?? (error.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1);
  process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
}
