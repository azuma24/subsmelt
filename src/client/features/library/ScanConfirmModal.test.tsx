import test from "node:test";
import assert from "node:assert/strict";
import { useTranslation } from "../../i18n";
import { renderPage } from "../../test-render";
import type { ScannedFile, TaskStatus } from "../../types";
import { makeTaskStatus } from "../../test-fixtures";
import {
  ScanConfirmModal,
  countScanSubtitles,
  countUntargetedSubtitles,
  summarizeScanFolders,
  type ScanPlan,
} from "./ScanConfirmModal";

const target: TaskStatus = makeTaskStatus({
  taskId: 1,
  targetLang: "Traditional Chinese",
  langCode: "chi",
  status: "new",
});

function subtitle(srtPath: string, tasks: TaskStatus[] = [target]): ScannedFile["subtitles"][number] {
  return { srtPath, srtName: srtPath.split("/").pop() || "", tasks };
}

const files: ScannedFile[] = [
  {
    videoPath: "/media/Show/Season1/Episode 01.mkv",
    videoName: "Episode 01.mkv",
    videoMtime: 1,
    subtitles: [
      subtitle("/media/Show/Season1/Episode 01.en.srt"),
      subtitle("/media/Show/Season1/Episode 01.ja.srt"),
      subtitle("/media/Show/Season1/Episode 01.forced.srt", []),
    ],
  },
  { videoPath: null, videoName: null, videoMtime: null, subtitles: [subtitle("/media/Docs/Lecture.en.srt")] },
];

test("folder counts follow subtitles a target applies to, not videos or untargeted subtitles, and add up to the summary count", () => {
  assert.deepEqual(summarizeScanFolders(files), [
    { name: "Season1", count: 2 },
    { name: "Docs", count: 1 },
  ]);
  assert.equal(countScanSubtitles(files), 3);
  assert.equal(countUntargetedSubtitles(files), 1);
});

function Modal({ plan }: { plan: ScanPlan }) {
  const { t } = useTranslation();
  return <ScanConfirmModal scanPlan={plan} onClose={() => {}} onConfirm={() => {}} t={t} />;
}

const topFolders = summarizeScanFolders(files);

test("with new jobs the modal offers Proceed and pluralized folder counts", () => {
  const page = renderPage(<Modal plan={{ files, newJobs: 2, topFolders }} />);

  assert.ok(page.text.includes("Found 3 subtitle files. 2 new jobs will be created."));
  assert.ok(page.text.includes("Season1 (2 subtitles), Docs (1 subtitle)"));
  assert.deepEqual(page.buttons.slice(1), ["Cancel", "Proceed"]);
});

test("with nothing to queue the modal says so and makes Close the primary action", () => {
  const page = renderPage(<Modal plan={{ files, newJobs: 0, topFolders }} />);

  assert.ok(
    page.text.includes(
      "Found 3 subtitle files, and every one already has a job or a finished output. Nothing new will be queued.",
    ),
  );
  assert.ok(!page.text.includes("0 new jobs"));
  assert.deepEqual(page.buttons.slice(1), ["Scan anyway", "Close"]);
});

test("subtitles with no applicable translation target are counted and point to Translations instead of reporting zero", () => {
  const untargeted: ScannedFile[] = [
    {
      videoPath: "/media/Show/Episode 01.mkv",
      videoName: "Episode 01.mkv",
      videoMtime: 1,
      subtitles: [subtitle("/media/Show/Episode 01.en.srt", []), subtitle("/media/Show/Episode 01.ja.srt", [])],
    },
    { videoPath: "/media/Show/Episode 02.mkv", videoName: "Episode 02.mkv", videoMtime: 1, subtitles: [] },
    { videoPath: null, videoName: null, videoMtime: null, subtitles: [subtitle("/media/Docs/Lecture.en.srt", [])] },
  ];
  const page = renderPage(
    <Modal plan={{ files: untargeted, newJobs: 0, topFolders: summarizeScanFolders(untargeted) }} />,
  );

  assert.ok(
    page.text.includes(
      "Found 3 subtitle files, but no translation target applies to any of them. Add or enable one in Translations.",
    ),
  );
  assert.ok(!page.text.includes("Found 0"));
  assert.deepEqual(page.buttons.slice(1), ["Scan anyway", "Close"]);
});
