import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts loads config.json at import, so plant the broken file first.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-config-"));
const configFile = path.join(configDir, "config.json");
const brokenBytes = '{"settings":{"model":"keep-me"},"tasks":[{"id":7,';
fs.writeFileSync(configFile, brokenBytes);
process.env.CONFIG_DIR = configDir;
const config = await import("./config.js");

test("an unparseable config.json is backed up and left untouched until the next save", () => {
  const backups = fs.readdirSync(configDir).filter((name) => name.startsWith("config.json.broken-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(configDir, backups[0]), "utf8"), brokenBytes);
  assert.equal(fs.readFileSync(configFile, "utf8"), brokenBytes);

  config.setSetting("model", "saved-after-recovery");

  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).settings.model, "saved-after-recovery");
});
