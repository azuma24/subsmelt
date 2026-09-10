import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

test("errors.json overlays translate every errors.* string (no English leftovers)", () => {
  const english = flatten(loadErrors("en"));
  assert.ok(Object.keys(english).length >= 6, "English errors.* baseline is unexpectedly empty");

  const localesRoot = join(process.cwd(), "src", "client", "locales");
  const overlayCodes = readdirSync(localesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(localesRoot, d.name, "errors.json")))
    .map((d) => d.name)
    .sort();

  assert.ok(overlayCodes.length >= 10, `expected many errors.json overlays, found ${overlayCodes.length}`);

  for (const code of overlayCodes) {
    if (code === "en") continue;
    const localeErrors = flatten(loadErrors(code));
    assert.deepEqual(Object.keys(localeErrors).sort(), Object.keys(english).sort(), `${code} errors.* keys differ from en`);
    const leftovers = Object.entries(english)
      .filter(([key, value]) => localeErrors[key] === value)
      .map(([key]) => key);
    assert.deepEqual(leftovers, [], `${code} still has English errors.*: ${leftovers.join(", ")}`);
  }
});
