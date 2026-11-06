import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-job-subtitles-"));
const media = path.join(root, "media");
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = media;
fs.mkdirSync(media);

const { createJob } = await import("../db.js");
const { registerJobsRoutes } = await import("./jobs.js");
const app = express();
registerJobsRoutes(app);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs`;
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const source = "1\n00:00:00,009 --> 00:00:02,007\nNOTE TO SELF\nRemember the key\n";
const translated = "[Events]\nFormat: Layer, Start, End, Text\nDialogue: 0,0:00:00.00,0:00:02.00,{\\i1}Clé\n";

function fixture(name: string, status: string) {
  const sourcePath = path.join(media, `${name}.srt`);
  const outputPath = path.join(media, `${name}.fra.ass`);
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(outputPath, translated);
  const { lastInsertRowid } = createJob({
    task_id: 1,
    srt_path: sourcePath,
    output_path: outputPath,
    video_path: null,
    status,
  });
  return { id: Number(lastInsertRowid), sourcePath, outputPath };
}

test("preview refuses an out-of-root partial subtitle and reads an ordinary one", async () => {
  const { id, outputPath } = fixture("preview", "translating");
  const outside = path.join(root, "outside.ass");
  const partial = `${outputPath}.part`;
  fs.writeFileSync(outside, translated.replace("Clé", "outside"));
  fs.symlinkSync(outside, partial);
  const refused = await fetch(`${base}/${id}/preview`);
  assert.equal(refused.status, 400);
  assert.doesNotMatch(await refused.text(), /Dialogue/);

  fs.unlinkSync(partial);
  fs.writeFileSync(partial, translated.replace("Clé", "partial"));
  const allowed = await fetch(`${base}/${id}/preview`);
  assert.equal(allowed.status, 200);
  const { lines, quality, canDownloadBilingual } = await allowed.json();
  assert.equal(lines[0].original, "NOTE TO SELF\nRemember the key");
  assert.match(lines[0].translated, /partial/);
  assert.deepEqual(quality, { original: [], translated: [] });
  assert.equal(canDownloadBilingual, false);
});

test("bilingual export downloads completed matching cues on the original clock", async () => {
  const { id, sourcePath, outputPath } = fixture("Movie", "done");
  const res = await fetch(`${base}/${id}/download?format=bilingual`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="Movie.fra.bilingual.srt"');
  assert.equal(await res.text(), source.replace("Remember the key\n", "Remember the key\nClé\n"));
  assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
  assert.equal(fs.readFileSync(outputPath, "utf8"), translated);

  // Replacing the result with a same-count file is still a mismatch when its clocks differ.
  fs.writeFileSync(outputPath, translated.replace("0:00:02.00", "0:00:03.00"));
  assert.equal((await fetch(`${base}/${id}/download?format=bilingual`)).status, 409);
  const pending = fixture("pending", "pending");
  assert.equal((await fetch(`${base}/${pending.id}/download?format=bilingual`)).status, 409);
});

test("preview attributes inherited timing suggestions to the source only", async () => {
  const { id, sourcePath, outputPath } = fixture("short", "done");
  fs.writeFileSync(sourcePath, "1\n00:00:00,000 --> 00:00:00,500\nHello\n");
  fs.writeFileSync(outputPath, translated.replace("0:00:02.00", "0:00:00.50").replace("Clé", "字".repeat(25)));
  const response = await fetch(`${base}/${id}/preview`);
  assert.equal(response.status, 200);
  const { quality } = await response.json();
  assert.deepEqual(
    quality.original.map(({ code }: { code: string }) => code),
    ["short"],
  );
  assert.deepEqual(
    quality.translated.map(({ code }: { code: string }) => code),
    ["width", "speed"],
  );

  fs.writeFileSync(outputPath, translated.replace("0:00:02.00", "0:00:00.40"));
  const retimed = await (await fetch(`${base}/${id}/preview`)).json();
  assert.deepEqual(retimed.quality.translated, [{ code: "short", cue: 1, value: 400, limit: 800 }]);
});
