import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as wait } from "node:timers/promises";

const root = mkdtempSync(path.join(os.tmpdir(), "subsmelt-intake-"));
const media = path.join(root, "media");
const folder = path.join(media, "Opted in");
mkdirSync(folder, { recursive: true });
process.env.DATA_DIR = path.join(root, "data");
process.env.CONFIG_DIR = path.join(root, "config");
process.env.MEDIA_DIR = media;

const { setSettings, createTask, updateTask } = await import("./config.js");
const { scanFolder } = await import("./scanner.js");
const { scanAndEnqueue } = await import("./library-scan.js");
const { assertSubtitleIntakeStillMissing } = await import("./subtitle-intake.js");
const { enqueueMissingTranscripts } = await import("./transcription/scheduled.js");
type WorkRunner = import("./transcription/work.js").WorkRunner;
after(() => rmSync(root, { recursive: true, force: true }));

const video = (name: string) => path.join(folder, `${name}.mkv`);
const srt = (text: string) => `1\n00:00:01,000 --> 00:00:03,000\n${text}\n\n`;
const options = { intake: "preview" as const, transcriptionAvailable: true };
const requireFfmpeg = {
  skip: !["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"]).status === 0),
};
const runFfmpeg = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", ...args]);

test(
  "shared intake prioritizes sources, leaves uncertain cases for review and invalidates a stale plan",
  requireFfmpeg,
  async () => {
    setSettings({
      scan_mode: "recursive",
      auto_translate: "0",
      transcription_enabled: "0",
      subtitle_intake_rules: JSON.stringify([
        { path: "Opted in", language: "en", fallback: "transcribe_and_translate" },
        { path: "Opted in/French", language: "fra", fallback: "off" },
      ]),
    });
    updateTask(1, { enabled: 0 });
    createTask({
      source_lang: "Automatic",
      target_lang: "Japanese",
      lang_code: "jpn",
      output_pattern: "{{name}}.{{lang_code}}.srt",
      enabled: 1,
    });
    const sub = path.join(root, "input.srt");
    writeFileSync(sub, srt("Full dialogue"));
    const makeVideo = (name: string, tracks: { language?: string; forced?: boolean }[]) => {
      const args = ["-f", "lavfi", "-i", "color=s=16x16:r=1:d=4"];
      tracks.forEach(() => {
        args.push("-i", sub);
      });
      args.push("-map", "0:v", "-c:v", "ffv1");
      tracks.forEach(({ language, forced }, index) => {
        args.push("-map", `${index + 1}:s`);
        if (language) args.push(`-metadata:s:s:${index}`, `language=${language}`);
        if (forced) args.push(`-disposition:s:${index}`, "forced");
      });
      args.push("-c:s", "copy", video(name));
      runFfmpeg(args);
    };
    makeVideo("Embedded", [{ language: "eng" }, { language: "eng", forced: true }]);
    makeVideo("Ambiguous", [{ language: "eng" }, { language: "eng" }]);
    makeVideo("Forced", [{ language: "eng", forced: true }]);
    makeVideo("Wrong language", [{ language: "fra" }]);
    makeVideo("Unlabelled", [{}]);
    makeVideo("Absent", []);
    makeVideo("Invalid sidecar", []);
    writeFileSync(video("Unreadable"), "partial data");
    writeFileSync(video("Prefer sidecar"), "does not need FFprobe");
    writeFileSync(path.join(folder, "Prefer sidecar.eng.srt"), srt("Local full dialogue"));
    writeFileSync(path.join(folder, "Prefer sidecar.eng.forced.srt"), srt("Signs"));
    writeFileSync(path.join(folder, "Invalid sidecar.eng.srt"), "invalid");
    mkdirSync(path.join(folder, "French"));
    renameSync(video("Wrong language"), path.join(folder, "French", "French title.mkv"));
    makeVideo("Wrong language", [{ language: "fra" }]);
    const legacy = path.join(media, "Legacy.mkv");
    writeFileSync(legacy, "outside the configured folders");

    let snapshot = await scanFolder(false, options);
    assert.equal(snapshot.files.find((file) => file.videoPath === video("Absent"))?.intake?.action, "settling");
    await wait(2_050);
    snapshot = await scanFolder(false, options);
    const row = (name: string) => snapshot.files.find((file) => file.videoName === `${name}.mkv`);
    assert.equal(row("Embedded")?.intake?.action, "embedded");
    assert.equal(row("Ambiguous")?.intake?.action, "ambiguous");
    assert.equal(row("Forced")?.intake?.action, "forced_only");
    assert.equal(row("Wrong language")?.intake?.action, "language_mismatch");
    assert.equal(row("Unlabelled")?.intake?.action, "ambiguous");
    assert.equal(row("Invalid sidecar")?.intake?.action, "invalid_sidecar");
    assert.equal(row("Unreadable")?.intake?.action, "probe_failed");
    assert.equal(row("Prefer sidecar")?.intake?.action, "sidecar");
    assert.equal(row("Prefer sidecar")?.subtitles.find((s) => s.srtName.endsWith("forced.srt"))?.tasks.length, 0);
    assert.equal(row("French title")?.intake?.action, "embedded");
    assert.equal(row("Legacy")?.intake, undefined);
    assert.equal(row("Absent")?.intake?.action, "transcribe_and_translate");
    const revision = row("Absent")?.intake?.revision;
    assert.ok(revision);
    assert.equal(existsSync(path.join(folder, "Embedded.eng.srt")), false);

    setSettings({ scan_mode: "selected", scan_folders: JSON.stringify(["Opted in", "Unavailable share"]) });
    const partial = await scanFolder(false, options);
    assert.equal(partial.complete, false);
    assert.equal(partial.files.find((file) => file.videoPath === video("Absent"))?.intake?.action, "asr_unavailable");
    setSettings({ scan_mode: "recursive" });

    const inputs: { input: string }[] = [];
    const runner = {
      start() {},
      store: { enqueue: (items: typeof inputs) => inputs.push(...items) },
    } as unknown as WorkRunner;
    enqueueMissingTranscripts(snapshot, "auto_transcribe", runner, () => false);
    assert.deepEqual(
      inputs.map((input) => input.input),
      [legacy],
    );

    await assertSubtitleIntakeStillMissing(video("Absent"), revision);
    writeFileSync(path.join(folder, "Absent.eng.srt"), srt("Arrived after preview"));
    await assert.rejects(assertSubtitleIntakeStillMissing(video("Absent"), revision), /subtitle appeared/i);

    const [watched, full] = await Promise.all([scanAndEnqueue("watcher"), scanAndEnqueue()]);
    assert.equal(watched.files.find((file) => file.videoPath === video("Embedded"))?.intake?.action, "imported");
    assert.equal(full.files.find((file) => file.videoPath === video("Embedded"))?.intake?.action, "sidecar");
    assert.equal(watched.newJobs, 4);
    assert.equal(full.newJobs, 0);

    makeVideo("Replacement", [{ language: "eng" }]);
    renameSync(video("Replacement"), video("Absent"));
    await assert.rejects(assertSubtitleIntakeStillMissing(video("Absent"), revision), /video changed/i);
  },
);

test("a source awaiting review stays out of scan and dequeue while other work remains eligible", async () => {
  const { registerSourceReviewGate } = await import("./transcription/review-gate.js");
  const { createJob, claimPendingJob, countPendingJobs } = await import("./db.js");
  const dir = path.join(media, "Review");
  mkdirSync(dir);
  const heldVideo = path.join(dir, "Held.mkv");
  const heldSubtitle = path.join(dir, "Held.eng.srt");
  writeFileSync(heldVideo, "Media");
  writeFileSync(heldSubtitle, srt("Unreviewed transcript"));
  setSettings({ scan_mode: "selected", scan_folders: JSON.stringify(["Review"]) });
  let awaitingReview = true;
  registerSourceReviewGate(
    (subtitlePath, videoPath) => !awaitingReview || (subtitlePath !== heldSubtitle && videoPath !== heldVideo),
    () => awaitingReview,
  );
  try {
    assert.equal((await scanFolder(false, options)).newJobs, 0);
    const held = Number(
      createJob({
        task_id: 2,
        srt_path: heldSubtitle,
        video_path: heldVideo,
        output_path: path.join(dir, "Held.jpn.srt"),
        status: "pending",
      }).lastInsertRowid,
    );
    const open = Number(
      createJob({
        task_id: 2,
        srt_path: path.join(dir, "Other.eng.srt"),
        video_path: null,
        output_path: path.join(dir, "Other.jpn.srt"),
        status: "pending",
      }).lastInsertRowid,
    );
    const ids = new Set([held, open]);
    assert.equal(countPendingJobs(ids), 1);
    assert.equal(claimPendingJob(ids)?.id, open);
    assert.equal(claimPendingJob(ids), null);
    awaitingReview = false;
    assert.equal(countPendingJobs(ids), 1);
    assert.equal(claimPendingJob(ids)?.id, held);
  } finally {
    registerSourceReviewGate(
      () => true,
      () => false,
    );
  }
});
