/**
 * SSA/ASS documents as sections of lines. A `Format` line lists the field
 * names that the `Style`, `Dialogue` and `Comment` lines after it map; every
 * other line keeps its value as one string. Comment lines (`; …`) survive a
 * round trip, as does the order of everything.
 */

/** A Format line lists field names; the lines a Format governs map them; everything else is a string. */
export type AssValue = string | string[] | Record<string, string>;

export interface AssLine {
  /** The text before the first colon, or ";" for a comment line. */
  key: string;
  value: AssValue;
}

export interface AssSection {
  section: string;
  body: AssLine[];
}

const SECTION_RE = /^\s*\[(.*)\]\s*$/;

function parseLine(line: string, format: string[] | null): AssLine | null {
  if (/^\s*$/.test(line)) return null;
  if (line[0] === ";") return { key: ";", value: line.slice(1) };

  const colon = line.indexOf(":");
  const key = colon === -1 ? line : line.slice(0, colon);
  const raw = colon === -1 ? "" : line.slice(colon + 1).trim();

  if (key === "Format") return { key, value: raw.split(",").map((field) => field.trim()) };
  if (!format) return { key, value: raw };

  // The last field (Text) may itself contain commas, so only format.length - 1
  // splits are made; a short line leaves the missing fields empty.
  const parts = raw.split(",");
  const fields =
    parts.length > format.length
      ? [...parts.slice(0, format.length - 1), parts.slice(format.length - 1).join(",")]
      : parts;
  const value: Record<string, string> = {};
  format.forEach((name, index) => {
    value[name] = (fields[index] ?? "").trim();
  });
  return { key, value };
}

/** Parses a whole document. Text before the first section header is ignored, as players ignore it. */
export function parseAss(content: string): AssSection[] {
  const sections: AssSection[] = [];
  let current: AssSection | null = null;
  let format: string[] | null = null;
  for (const line of content.replace(/^﻿/, "").split(/\r?\n/)) {
    const header = SECTION_RE.exec(line);
    if (header) {
      current = { section: header[1], body: [] };
      format = null;
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(line, format);
    if (!parsed) continue;
    if (parsed.key === "Format" && !format && Array.isArray(parsed.value)) format = parsed.value;
    current.body.push(parsed);
  }
  return sections;
}

function stringifyLine(line: AssLine, format: string[] | null): string {
  if (line.key === ";") return `;${line.value}`;
  if (Array.isArray(line.value)) return `${line.key}: ${line.value.join(", ")}`;
  if (typeof line.value === "object") {
    const fields = format ?? Object.keys(line.value);
    const value = line.value;
    return `${line.key}: ${fields.map((name) => value[name] ?? "").join(",")}`;
  }
  return `${line.key}: ${line.value}`;
}

/** The document as text: sections separated by a blank line, a trailing newline at the end. */
export function stringifyAss(sections: AssSection[]): string {
  return `${sections
    .map((section) => {
      let format: string[] | null = null;
      const body = section.body
        .map((line) => {
          if (line.key === "Format" && Array.isArray(line.value)) format = line.value;
          return stringifyLine(line, format);
        })
        .join("\n");
      const head = `[${section.section}]`;
      return body ? `${head}\n${body}` : head;
    })
    .join("\n\n")}\n`;
}
