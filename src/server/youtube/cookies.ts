import fs from "node:fs";
import path from "node:path";
import type { Parsed } from "../routes/validation.js";
import { youtubeTmpRoot } from "./ytdlp.js";

const MAX_COOKIES_BYTES = 1024 * 1024;
// A Netscape cookie line: domain, subdomains flag, path, secure flag, expiry, name, value.
const COOKIE_LINE_RE = /^(#HttpOnly_)?[^\t#][^\t]*\t(TRUE|FALSE)\t[^\t]*\t(TRUE|FALSE)\t-?\d+\t[^\t]*\t[^\t]*$/i;

export interface CookiesStatus {
  present: boolean;
  /** When the file was uploaded; the content itself never leaves the server. */
  updatedAt: string | null;
}

export function cookiesPath(): string {
  return path.resolve(process.env.DATA_DIR || "./data", "youtube", "cookies.txt");
}

export function parseCookies(content: unknown): Parsed<string> {
  if (typeof content !== "string" || !content.trim())
    return { ok: false, error: "Paste the contents of a cookies.txt file" };
  if (Buffer.byteLength(content) > MAX_COOKIES_BYTES) return { ok: false, error: "cookies.txt is larger than 1 MB" };
  const text = content.replace(/\r\n/g, "\n");
  if (!text.split("\n").some((line) => COOKIE_LINE_RE.test(line.trim()))) {
    return { ok: false, error: "This is not a cookies.txt file in Netscape format" };
  }
  return { ok: true, value: text.endsWith("\n") ? text : `${text}\n` };
}

export function cookiesStatus(): CookiesStatus {
  try {
    return { present: true, updatedAt: fs.statSync(cookiesPath()).mtime.toISOString() };
  } catch {
    return { present: false, updatedAt: null };
  }
}

/** Writes through a temp file so a half-written jar is never used, readable by the server user only. */
export function saveCookies(text: string): CookiesStatus {
  const file = cookiesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  return cookiesStatus();
}

export function removeCookies(): void {
  fs.rmSync(cookiesPath(), { force: true });
}

/**
 * yt-dlp writes its cookie jar back when it exits, so each run gets its own
 * copy and the uploaded file is never rewritten. Returns null without cookies.
 */
export function copyCookiesInto(dir: string): string | null {
  const copy = path.join(dir, "cookies.txt");
  try {
    fs.copyFileSync(cookiesPath(), copy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  fs.chmodSync(copy, 0o600);
  return copy;
}

/**
 * Runs a yt-dlp call that has no scratch folder of its own (a listing, a
 * lookup) with `--cookies` on a private copy of the jar, removed afterwards.
 * Without uploaded cookies the call gets no extra arguments.
 */
export async function withCookieArgs<T>(run: (cookieArgs: string[]) => Promise<T>): Promise<T> {
  if (!fs.existsSync(cookiesPath())) return run([]);
  fs.mkdirSync(youtubeTmpRoot(), { recursive: true });
  const dir = fs.mkdtempSync(path.join(youtubeTmpRoot(), "cookies-"));
  try {
    const copy = copyCookiesInto(dir);
    return await run(copy ? ["--cookies", copy] : []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
