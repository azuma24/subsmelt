import type { ReasoningOutput } from "ai";

// ── Secret/snippet helpers ───────────────────────────────────────────────────

export function sanitizeSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
    .replace(/("api[_-]?key"\s*:\s*")[^"]+("?)/gi, "$1***$2");
}

export function truncate(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function toSnippet(value: unknown, max = 600): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncate(sanitizeSecrets(value), max);
  try {
    return truncate(sanitizeSecrets(JSON.stringify(value)), max);
  } catch {
    return truncate(String(value), max);
  }
}

// ── JSON / reasoning extraction helpers ──────────────────────────────────────

/** Extract plain text from AI SDK reasoning output (may be string or ReasoningOutput[]). */
export function extractReasoningText(reasoning: string | ReasoningOutput[] | undefined): string {
  if (!reasoning) return "";
  if (typeof reasoning === "string") return reasoning;
  return reasoning.map((r) => ("text" in r ? r.text : "")).join("");
}

export function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function extractJsonFromText(value: string): unknown {
  const direct = tryJsonParse(value);
  if (direct != null) return direct;

  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsedFence = tryJsonParse(fenced[1].trim());
    if (parsedFence != null) return parsedFence;
  }

  const startObj = value.indexOf("{");
  const endObj = value.lastIndexOf("}");
  if (startObj >= 0 && endObj > startObj) {
    const maybeObj = value.slice(startObj, endObj + 1);
    const parsedObj = tryJsonParse(maybeObj);
    if (parsedObj != null) return parsedObj;
  }

  const startArr = value.indexOf("[");
  const endArr = value.lastIndexOf("]");
  if (startArr >= 0 && endArr > startArr) {
    const maybeArr = value.slice(startArr, endArr + 1);
    const parsedArr = tryJsonParse(maybeArr);
    if (parsedArr != null) return parsedArr;
  }

  return null;
}

export function stripMarkdownFences(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

export function coerceTranslatedArray(parsed: unknown): string[] | null {
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const candidates = [obj.translated, obj.result, obj.results, obj.translations];
    for (const value of candidates) {
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return value as string[];
      }
    }
  }
  return null;
}

export function coerceSingleTranslation(parsed: unknown, rawText: string): string | null {
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const candidates = [obj.result, obj.translated, obj.translation, obj.text];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  const cleaned = stripMarkdownFences(rawText);
  if (!cleaned) return null;

  const quoted = cleaned.match(/^"([\s\S]*)"$/);
  if (quoted?.[1]) return quoted[1].trim();

  // If cleaned text is very long it's a reasoning trace, not a translation.
  // Return null so the caller falls through to the plain-text generateText fallback.
  if (cleaned.length > 400) return null;

  return cleaned;
}

/**
 * Extract the final translation answer from a reasoning/thinking trace.
 * Reasoning models write long chain-of-thought before settling on a final answer.
 * We look for the last clean quoted string (「...」 or "...") or the last
 * non-meta line (not starting with *, -, Let, Wait, Note, Option, #).
 * Returns null if no clean answer is found (caller falls through to text fallback).
 */
export function extractFinalAnswerFromReasoning(reasoning: string): string | null {
  if (!reasoning || reasoning.length < 2) return null;

  // Try last 「...」 or "..." quoted block
  const quotedMatches = [...reasoning.matchAll(/[「"]([^「」""]{1,300})[」"]/g)];
  if (quotedMatches.length > 0) {
    const last = quotedMatches[quotedMatches.length - 1][1].trim();
    if (last && last.length >= 1 && last.length <= 300) return last;
  }

  // Try last non-meta line that looks like a translation (contains CJK or is short)
  const lines = reasoning.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Skip meta lines
    if (/^[\*\-#>]/.test(line)) continue;
    if (/^(let'?s|wait|note:|option \d|actually|final|refin|translat|source|input|context|glossary|target)/i.test(line)) continue;
    // Must be reasonably short (subtitle line)
    if (line.length > 300 || line.length < 1) continue;
    return line;
  }

  return null;
}

/**
 * Extract translations from Gemma-style numbered reasoning output.
 * Gemma writes: 1. "source" -> 翻譯  or  1.  翻譯
 * Returns array in order, or null if pattern not found.
 */
export function extractNumberedTranslations(text: string, expectedCount: number): string[] | null {
  // Match patterns like: 1. "..." -> 翻譯  or  1. 翻譯  or  1.  翻譯
  const lines = text.split("\n");
  const results: Map<number, string> = new Map();

  for (const line of lines) {
    // Pattern: N. "source" -> translation   OR   N. translation
    const arrowMatch = line.match(/^\s*(\d+)\.\s+(?:"[^"]*"\s*->\s*)(.+)$/);
    if (arrowMatch) {
      const idx = parseInt(arrowMatch[1], 10);
      const val = arrowMatch[2].replace(/^\s*["「]|["」]\s*$/g, "").trim();
      if (val) results.set(idx, val);
      continue;
    }
    // Pattern: N. translation (no arrow, no source quoted)
    const simpleMatch = line.match(/^\s*(\d+)\.\s+([^"*\-].+)$/);
    if (simpleMatch) {
      const idx = parseInt(simpleMatch[1], 10);
      const val = simpleMatch[2].replace(/^\s*["「]|["」]\s*$/g, "").trim();
      // Skip meta lines
      if (val && !/^(Note:|Wait,|Looking|Actually|However|Correct|Let'?s|Refin|Source:|Target:|Input:)/.test(val)) {
        if (!results.has(idx)) results.set(idx, val);
      }
    }
  }

  if (results.size === 0) return null;

  // Build ordered array — use last seen value for each index
  const arr: string[] = [];
  for (let i = 1; i <= Math.max(expectedCount, ...results.keys()); i++) {
    const v = results.get(i);
    if (v !== undefined) arr.push(v);
  }

  // Only return if we got close to the expected count
  if (arr.length >= Math.floor(expectedCount * 0.7)) return arr;
  return null;
}
