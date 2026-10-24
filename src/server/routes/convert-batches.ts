import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAllSettings, AUTO_SOURCE_LANGUAGE } from "../config.js";
import { resolveConnectionPool } from "../connections.js";
import { convertSubtitle, translateFile, planJobContext } from "../translator.js";
import { sanitizeLanguageName } from "./validation.js";
import { logger } from "../logger.js";

// JSON uploads are constrained independently of the global Express 25mb parser.
// No input or output bytes are returned by the status endpoint.
export const MAX_BATCH_FILES = 10;
export const MAX_BATCH_FILE_BYTES = 1024 * 1024;
export const MAX_BATCH_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_JOBS = 20;
export const BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const FORMATS = ["srt", "vtt", "ass", "ssa"];
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function convertBatchRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.CONVERT_BATCH_DIR || path.join(env.DATA_DIR || "./data", "convert-batches"));
}
const ROOT = convertBatchRoot(process.env);

type Input = { name: string; content: string; sourceLang?: string; skip?: boolean };
type Options = {
  files: Input[];
  targetFormat: string;
  translate: boolean;
  targetLang: string;
  targetCode: string;
  sourceLang: string;
};
type FileState = {
  name: string;
  status: "pending" | "working" | "done" | "error";
  outputName?: string;
  error?: string;
};
type Job = {
  id: string;
  createdAt: number;
  finishedAt?: number;
  status: "pending" | "running" | "done";
  files: FileState[];
  options: Omit<Options, "files">;
};

function safeName(value: string): string {
  // Input names have already passed path/control-character validation.
  const sanitized = value.replace(/:/g, "_");
  if (sanitized.length <= 180) return sanitized;
  const ext = sanitized.match(/\.(?:srt|vtt|ass|ssa)$/i)?.[0] ?? "";
  return sanitized.slice(0, 180 - ext.length) + ext;
}
function jobDir(id: string): string {
  if (!ID.test(id)) throw new Error("Invalid job ID");
  return path.join(ROOT, id);
}
function regular(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}
function load(id: string): Job | null {
  if (!ID.test(id)) return null;
  const dir = jobDir(id);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || !regular(path.join(dir, "job.json"))) return null;
  try {
    const job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")) as Job;
    if (job.id !== id || !Array.isArray(job.files) || job.files.length > MAX_BATCH_FILES || !job.options) return null;
    return job;
  } catch {
    return null;
  }
}
function save(job: Job): void {
  const dir = jobDir(job.id);
  const tmp = path.join(dir, "job.tmp");
  fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "job.json"));
}
function entries(): string[] {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  return fs.readdirSync(ROOT).filter((id) => ID.test(id) && fs.lstatSync(jobDir(id)).isDirectory());
}
function clean(): void {
  for (const id of entries()) {
    const job = load(id);
    // Retention starts on completion. Active work can exceed the TTL.
    if (!job || (job.status === "done" && Date.now() - (job.finishedAt ?? job.createdAt) > BATCH_TTL_MS)) {
      fs.rmSync(jobDir(id), { recursive: true, force: true });
    }
  }
}
function validate(raw: unknown): Options {
  if (!raw || typeof raw !== "object") throw new Error("Invalid request");
  const body = raw as Record<string, unknown>;
  if (typeof body.targetFormat !== "string" || !FORMATS.includes(body.targetFormat))
    throw new Error("Invalid target format");
  if (body.translate !== true && body.translate !== false) throw new Error("Invalid translate flag");
  if (
    body.translate &&
    (typeof body.targetLang !== "string" || body.targetLang.length > 120 || !sanitizeLanguageName(body.targetLang))
  )
    throw new Error("Target language required");
  if (body.sourceLang !== undefined && (typeof body.sourceLang !== "string" || body.sourceLang.length > 120))
    throw new Error("Invalid source language");
  if (
    body.targetCode !== undefined &&
    (typeof body.targetCode !== "string" || !/^[A-Za-z0-9-]{0,32}$/.test(body.targetCode))
  )
    throw new Error("Invalid target code");
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > MAX_BATCH_FILES)
    throw new Error(`File count must be 1-${MAX_BATCH_FILES}`);
  let total = 0;
  for (const file of body.files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.name !== "string" ||
      typeof file.content !== "string" ||
      !file.name ||
      file.name.length > 240 ||
      [...file.name].some(
        (char) => char === "/" || char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      typeof file.skip !== "boolean" ||
      (file.sourceLang !== undefined && (typeof file.sourceLang !== "string" || file.sourceLang.length > 120))
    )
      throw new Error("Invalid file");
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (bytes > MAX_BATCH_FILE_BYTES || total > MAX_BATCH_BYTES) throw new Error("Upload size limit exceeded");
  }
  return {
    files: body.files as Input[],
    targetFormat: body.targetFormat,
    translate: body.translate,
    targetLang: sanitizeLanguageName(String(body.targetLang || "")),
    targetCode: String(body.targetCode || ""),
    sourceLang: sanitizeLanguageName(String(body.sourceLang || "")) || AUTO_SOURCE_LANGUAGE,
  };
}

export class ConvertBatchStore {
  private running = false;
  private queued = false;
  constructor(
    private readonly processFile: (
      input: Input,
      options: Job["options"],
      inputPath: string,
      outputPath: string,
    ) => Promise<string>,
    private readonly root = ROOT,
  ) {
    if (this.root !== ROOT) throw new Error("Use CONVERT_BATCH_DIR to configure the batch root");
    clean();
    this.kick();
  }
  create(raw: unknown): string {
    const options = validate(raw);
    clean();
    if (entries().length >= MAX_BATCH_JOBS) throw new Error("Batch capacity reached; wait for retention expiry");
    const id = randomUUID();
    const dir = jobDir(id);
    fs.mkdirSync(dir, { mode: 0o700 });
    try {
      const { files, ...settings } = options;
      const job: Job = {
        id,
        createdAt: Date.now(),
        status: "pending",
        options: settings,
        files: files.map((file) => ({ name: safeName(file.name), status: "pending" })),
      };
      files.forEach((file, i) => {
        fs.writeFileSync(path.join(dir, `input-${i}`), file.content, { mode: 0o600 });
      });
      fs.writeFileSync(
        path.join(dir, "inputs.json"),
        JSON.stringify(files.map(({ name, sourceLang, skip }) => ({ name: safeName(name), sourceLang, skip }))),
        { mode: 0o600 },
      );
      save(job);
      this.kick();
      return id;
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  get(id: string): Job | null {
    const job = load(id);
    return job && (job.status !== "done" || Date.now() - (job.finishedAt ?? job.createdAt) <= BATCH_TTL_MS)
      ? job
      : null;
  }
  list(): Pick<Job, "id" | "status" | "createdAt" | "finishedAt" | "files">[] {
    clean();
    return entries()
      .map((id) => this.get(id))
      .filter((job): job is Job => job !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, status, createdAt, finishedAt, files }) => ({ id, status, createdAt, finishedAt, files }));
  }
  output(id: string, index: number): { name: string; content: Buffer } | null {
    const job = this.get(id);
    if (
      !job ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= job.files.length ||
      job.files[index].status !== "done"
    )
      return null;
    const file = path.join(jobDir(id), `output-${index}`);
    if (!regular(file) || fs.statSync(file).size > MAX_BATCH_FILE_BYTES) return null;
    return { name: job.files[index].outputName!, content: fs.readFileSync(file) };
  }
  kick(): void {
    if (this.running) {
      this.queued = true;
      return;
    }
    void this.run().catch((error) => logger.error("system", `Convert batch worker: ${String(error)}`));
  }
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const id of entries()) {
        const job = this.get(id);
        if (!job || job.status === "done") continue;
        job.status = "running";
        save(job);
        for (let i = 0; i < job.files.length; i++) {
          const file = job.files[i];
          if (file.status === "done" || file.status === "error") continue;
          file.status = "working";
          save(job);
          try {
            const dir = jobDir(id);
            const input = path.join(dir, `input-${i}`);
            if (!regular(input) || !regular(path.join(dir, "inputs.json")))
              throw new Error("Uploaded input unavailable");
            const metadata = JSON.parse(fs.readFileSync(path.join(dir, "inputs.json"), "utf8"))[i] as Input;
            const content = fs.readFileSync(input, "utf8");
            const result = await this.processFile(
              { ...metadata, content },
              job.options,
              input,
              path.join(dir, `output-${i}`),
            );
            if (Buffer.byteLength(result, "utf8") > MAX_BATCH_FILE_BYTES) throw new Error("Output size limit exceeded");
            fs.writeFileSync(path.join(dir, `output-${i}`), result, { mode: 0o600 });
            const base = file.name.replace(/\.[^.]*$/, "");
            file.outputName = `${base}${job.options.translate && !metadata.skip ? `.${job.options.targetCode || "translated"}` : ""}.${job.options.targetFormat}`;
            file.status = "done";
            // Commit the result before discarding its only recoverable input.
            save(job);
          } catch (error) {
            file.status = "error";
            file.error = error instanceof Error ? error.message.slice(0, 300) : "Conversion failed";
            fs.rmSync(path.join(jobDir(id), `output-${i}`), { force: true });
          } finally {
            save(job);
            fs.rmSync(path.join(jobDir(id), `input-${i}`), { force: true });
          }
        }
        fs.rmSync(path.join(jobDir(id), "inputs.json"), { force: true });
        job.status = "done";
        job.finishedAt = Date.now();
        save(job);
      }
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.kick();
      }
    }
  }
}

async function processConvert(
  input: Input,
  options: Job["options"],
  inputPath: string,
  outputPath: string,
): Promise<string> {
  const ext = input.name.split(".").pop()?.toLowerCase() || "";
  if (!FORMATS.includes(ext)) throw new Error("Unsupported source extension");
  if (!options.translate || input.skip) return convertSubtitle(input.content, ext, options.targetFormat);
  const settings = getAllSettings();
  const { mode, pool } = resolveConnectionPool(settings);
  const primary = pool[0];
  if (!primary) throw new Error("No usable LLM connection configured");
  const chunkSize = Math.max(1, parseInt(settings.chunk_size || "20", 10) || 20);
  const apiHost = primary.apiHost || settings.llm_endpoint || "http://localhost:8000/v1";
  const ctxPlan = await planJobContext(pool, {
    fallbackHost: apiHost,
    chunkSize,
    configuredParallel: Math.max(1, Math.min(8, parseInt(settings.parallel_chunks || "1", 10))),
  });
  const translatedInput = `${inputPath}.${ext}`;
  const translatedOutput = `${outputPath}.${options.targetFormat}`;
  fs.writeFileSync(translatedInput, input.content, { mode: 0o600 });
  try {
    await translateFile({
      srtPath: translatedInput,
      outputPath: translatedOutput,
      apiKey: primary.apiKey || "",
      apiHost,
      model: primary.model || "",
      provider: primary.provider,
      connections: pool,
      llmMode: mode,
      prompt: settings.prompt || "",
      lang: options.targetLang,
      sourceLang: sanitizeLanguageName(input.sourceLang || "") || options.sourceLang,
      additional: settings.additional_context || "",
      temperature: parseFloat(settings.temperature || "0.3"),
      chunkSize,
      contextSize: parseInt(settings.context_window || "5", 10),
      parallelChunks: ctxPlan.parallelChunks,
      analysisLinesByConnection: new Map(
        [...ctxPlan.byConnection].map(([id, info]) => [id, info.recommendedAnalysisLines]),
      ),
      requestTimeoutMs: Math.max(5_000, parseInt(settings.request_timeout_s || "300", 10) * 1000),
      disableToolCalls: settings.disable_tool_calls === "1",
      refinePass: settings.refine_pass === "1",
      seriesMemory: false,
    });
    if (!regular(translatedOutput) || fs.statSync(translatedOutput).size > MAX_BATCH_FILE_BYTES)
      throw new Error("Output size limit exceeded");
    return fs.readFileSync(translatedOutput, "utf8");
  } finally {
    fs.rmSync(translatedInput, { force: true });
    fs.rmSync(translatedOutput, { force: true });
  }
}

export function registerConvertBatchRoutes(app: Express): void {
  const store = new ConvertBatchStore(processConvert);
  const timer = setInterval(() => {
    clean();
    store.kick();
  }, 60_000);
  timer.unref();
  app.get("/api/convert/batches", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ batches: store.list() });
  });
  app.post("/api/convert/batches", (req, res) => {
    try {
      const id = store.create(req.body);
      res.status(202).json({ id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid batch" });
    }
  });
  app.get("/api/convert/batches/:id", (req, res) => {
    const job = store.get(req.params.id as string);
    if (!job) return res.status(404).json({ error: "Batch not found" });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      files: job.files,
    });
  });
  app.get("/api/convert/batches/:id/files/:index", (req, res) => {
    const index = Number(req.params.index);
    const output = store.output(req.params.id as string, index);
    if (!output) return res.status(404).json({ error: "Output not found" });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(output.name)}`);
    res.type("text/plain; charset=utf-8").send(output.content);
  });
}
