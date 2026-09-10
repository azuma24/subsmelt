import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "../app/constants";

type JsonObject = Record<string, unknown>;

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return prefix ? { [prefix]: value } : {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.entries(value as JsonObject).reduce<Record<string, string>>((acc, [key, nested]) => {
    Object.assign(acc, flatten(nested, prefix ? `${prefix}.${key}` : key));
    return acc;
  }, {});
}

function loadErrors(code: string): JsonObject {
  const overlay = join(process.cwd(), "src", "client", "locales", code, "errors.json");
  if (existsSync(overlay)) {
    return JSON.parse(readFileSync(overlay, "utf8"));
  }
  const file = join(process.cwd(), "src", "client", "locales", code, "translation.json");
  return JSON.parse(readFileSync(file, "utf8")).errors as JsonObject;
}

test("non-English locales translate every errors.* string (no English leftovers)", () => {
  const english = flatten(loadErrors("en"));
  assert.ok(Object.keys(english).length >= 6, "English errors.* baseline is unexpectedly empty");

  for (const lang of LANGUAGES) {
    if (lang.code === "en") continue;
    const localeErrors = flatten(loadErrors(lang.code));
    assert.deepEqual(Object.keys(localeErrors).sort(), Object.keys(english).sort(), `${lang.code} errors.* keys differ from en`);
    const leftovers = Object.entries(english)
      .filter(([key, value]) => localeErrors[key] === value)
      .map(([key]) => key);
    assert.deepEqual(leftovers, [], `${lang.code} still has English errors.*: ${leftovers.join(", ")}`);
  }
});
