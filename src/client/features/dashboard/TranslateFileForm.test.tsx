import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import type { ScannedFile, Task } from "../../types";
import { resolveTargetLanguage } from "../convert/resolve-language";
import { TranslateFileForm, translateFileRequest } from "./TranslateFileForm";
import { withQueuedTask } from "../library/task-status";

const srtPath = "/media/show/Episode 01.srt";
const task = (id: number, lang_code: string, target_lang: string): Task => ({
  id,
  source_lang: "Automatic",
  target_lang,
  output_pattern: "{{name}}.{{lang_code}}.srt",
  lang_code,
  enabled: 1,
  prompt_override: "",
});

test("a resolved language submits its code and prompt name; an ambiguous one submits nothing", () => {
  assert.deepEqual(
    translateFileRequest(srtPath, { kind: "language", resolution: resolveTargetLanguage("Traditional Chinese") }),
    { srtPath, langCode: "zh-TW", targetLang: "Traditional Chinese (Taiwan)" },
  );
  assert.equal(translateFileRequest(srtPath, { kind: "language", resolution: resolveTargetLanguage("Chinese") }), null);
  assert.equal(translateFileRequest(srtPath, { kind: "language", resolution: resolveTargetLanguage("Klingonese") }), null);
  assert.deepEqual(translateFileRequest(srtPath, { kind: "task", task: task(3, "fr", "French") }), { srtPath, taskId: 3 });
});

test("the form offers only tasks the subtitle lacks and holds Translate until a language is chosen", () => {
  const page = renderPage(
    <TranslateFileForm
      srtPath={srtPath}
      existingTasks={[{ taskId: 1, langCode: "eng", targetLang: "English", outputName: "", status: "done", jobId: 4 }]}
      onQueued={() => {}}
      onCancel={() => {}}
    />,
    [[["tasks"], [task(1, "eng", "English"), task(2, "ja", "Japanese")]]],
  );

  assert.deepEqual(page.buttons, ["Japanese · ja", "Cancel", "Translate"]);
  assert.match(page.html, /<button type="submit" disabled=""[^>]*>Translate<\/button>/);
});

test("a queued translation replaces the subtitle's stale chip for that task", () => {
  const files: ScannedFile[] = [
    {
      videoPath: "/media/show/Episode 01.mkv",
      videoName: "Episode 01.mkv",
      videoMtime: null,
      subtitles: [
        {
          srtPath,
          srtName: "Episode 01.srt",
          tasks: [
            { taskId: 1, langCode: "eng", targetLang: "English", outputName: "Episode 01.eng.srt", status: "done", jobId: 4 },
            { taskId: 2, langCode: "ja", targetLang: "Japanese", outputName: "Episode 01.ja.srt", status: "error", jobId: 5 },
          ],
        },
      ],
    },
  ];

  const next = withQueuedTask(files, srtPath, {
    taskId: 2, langCode: "ja", targetLang: "Japanese", outputName: "", status: "pending", jobId: 5,
  });

  assert.deepEqual(
    next[0].subtitles[0].tasks.map((t) => `${t.langCode}:${t.status}`),
    ["eng:done", "ja:pending"],
  );
  assert.equal(files[0].subtitles[0].tasks[1].status, "error");
});
