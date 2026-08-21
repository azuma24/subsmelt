import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TITLE_SIDECAR_FILENAME,
  cleanMediaTitle,
  loadTitleSidecar,
  getTitle,
  withTitle,
  saveTitleSidecar,
  ensureTranslatedTitle,
  sanitizeTitle,
  pruneTitleSidecar,
  type TitleSidecar,
} from "./title-sidecar.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-title-sidecar-"));
}

// ── cleanMediaTitle ─────────────────────────────────────────────────────────

test("cleanMediaTitle: strips year, resolution, source, codec, release group", () => {
  assert.equal(cleanMediaTitle("Inception.2010.1080p.BluRay.x264-SPARKS"), "Inception");
});

test("cleanMediaTitle: keeps SxxEyy episode marker but cuts at resolution/source", () => {
  assert.equal(cleanMediaTitle("Show.S01E02.The.Heist.720p.WEB-DL"), "Show S01E02 The Heist");
});

test("cleanMediaTitle: replaces underscores with spaces", () => {
  assert.equal(cleanMediaTitle("My_Movie"), "My Movie");
});

test("cleanMediaTitle: never cuts at index 0, even if the first token is a year", () => {
  assert.equal(cleanMediaTitle("2012.2009.1080p"), "2012");
});

test("cleanMediaTitle: index-0 cut tokens are never cut on, only later ones", () => {
  // "1080p" is a cut token but sits at index 0 so it's kept; "BluRay" at index 1
  // is the first token eligible to cut on.
  assert.equal(cleanMediaTitle("1080p.BluRay.x264"), "1080p");
});

test("cleanMediaTitle: keeps a bare hyphen-suffixed stem as-is", () => {
  assert.equal(cleanMediaTitle("-GROUP"), "-GROUP");
});

test("cleanMediaTitle: strips trailing release group after all other cuts", () => {
  assert.equal(cleanMediaTitle("Some.Great.Show.2021.WEBRip.x265-GROUP"), "Some Great Show");
});

test("cleanMediaTitle: cuts a tag-GROUP compound token", () => {
  assert.equal(cleanMediaTitle("Inception.x264-SPARKS"), "Inception");
});

test("cleanMediaTitle: preserves hyphenated titles with no release tags", () => {
  assert.equal(cleanMediaTitle("Spider-Man"), "Spider-Man");
  assert.equal(cleanMediaTitle("Spider-Man.2002.1080p"), "Spider-Man");
});

test("cleanMediaTitle: strips bracket tags entirely, wherever they appear", () => {
  assert.equal(cleanMediaTitle("[SubsPlease] Frieren - 05 (1080p) [ABCD1234]"), "Frieren - 05");
});

test("cleanMediaTitle: bracket stripping does not count toward the index-0 rule", () => {
  assert.equal(cleanMediaTitle("[YTS] Inception.2010"), "Inception");
});

test("cleanMediaTitle: parenthesized year is a cut token like a bare year", () => {
  assert.equal(cleanMediaTitle("Inception.(2010).1080p"), "Inception");
});

test("cleanMediaTitle: keeps 1x05 style episode markers", () => {
  assert.equal(cleanMediaTitle("Show.1x05.Name.720p"), "Show 1x05 Name");
});

test("cleanMediaTitle: keeps multi-episode SxxEyy-Eyy markers", () => {
  assert.equal(cleanMediaTitle("Show.S01E01-E02.720p"), "Show S01E01-E02");
});

test("cleanMediaTitle: keeps multi-episode SxxEyyEyy markers (no dash)", () => {
  assert.equal(cleanMediaTitle("Show.S01E01E02.720p"), "Show S01E01E02");
});

test("cleanMediaTitle: removes a dangling trailing dash left after bracket stripping", () => {
  assert.equal(cleanMediaTitle("Frieren - [1080p]"), "Frieren");
});

// ── sanitizeTitle ─────────────────────────────────────────────────────────

test("sanitizeTitle: strips wrapping straight double quotes", () => {
  assert.equal(sanitizeTitle('"盗梦空间"'), "盗梦空间");
});

test("sanitizeTitle: takes only the first non-empty line", () => {
  assert.equal(sanitizeTitle("The Title\nExtra explanation"), "The Title");
});

test("sanitizeTitle: strips wrapping guillemets and surrounding whitespace", () => {
  assert.equal(sanitizeTitle("  «Le Titre»  "), "Le Titre");
});

test("sanitizeTitle: empty input returns empty string", () => {
  assert.equal(sanitizeTitle(""), "");
});

test("sanitizeTitle: strips wrapping curly double quotes", () => {
  assert.equal(sanitizeTitle("“Hello World”"), "Hello World");
});

test("sanitizeTitle: strips wrapping single quotes", () => {
  assert.equal(sanitizeTitle("'Hello World'"), "Hello World");
});

test("sanitizeTitle: strips wrapping corner brackets", () => {
  assert.equal(sanitizeTitle("「こんにちは」"), "こんにちは");
});

test("sanitizeTitle: skips leading blank lines", () => {
  assert.equal(sanitizeTitle("\n\n  Real Title  \nExtra"), "Real Title");
});

// ── loadTitleSidecar / saveTitleSidecar ─────────────────────────────────────

test("loadTitleSidecar: returns empty sidecar for nonexistent directory", () => {
  const dir = path.join(os.tmpdir(), "subsmelt-title-sidecar-does-not-exist-" + Date.now());
  const sidecar = loadTitleSidecar(dir);
  assert.deepEqual(sidecar, { version: 1, titles: {} });
});

test("loadTitleSidecar: returns empty sidecar for corrupt JSON", () => {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, TITLE_SIDECAR_FILENAME), "{ not valid json", "utf8");
    const sidecar = loadTitleSidecar(dir);
    assert.deepEqual(sidecar, { version: 1, titles: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTitleSidecar: round-trips a value written by saveTitleSidecar", () => {
  const dir = mkTmpDir();
  try {
    const sidecar: TitleSidecar = { version: 1, titles: { "Some.Movie": { zh: "某电影" } } };
    saveTitleSidecar(dir, sidecar);
    const loaded = loadTitleSidecar(dir);
    assert.deepEqual(loaded, sidecar);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveTitleSidecar: writing into an unwritable/nonexistent path does not throw", () => {
  const badDir = path.join(os.tmpdir(), "subsmelt-title-sidecar-nope", "deeper", "still-not-there");
  assert.doesNotThrow(() => {
    saveTitleSidecar(badDir, { version: 1, titles: {} });
  });
});

test("saveTitleSidecar: merges with on-disk content instead of overwriting it", () => {
  const dir = mkTmpDir();
  try {
    saveTitleSidecar(dir, { version: 1, titles: { A: { en: "Alpha" } } });
    saveTitleSidecar(dir, { version: 1, titles: { B: { en: "Beta" } } });

    const loaded = loadTitleSidecar(dir);
    assert.deepEqual(loaded, {
      version: 1,
      titles: { A: { en: "Alpha" }, B: { en: "Beta" } },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveTitleSidecar: in-memory value wins over on-disk value for the same (base, langCode)", () => {
  const dir = mkTmpDir();
  try {
    saveTitleSidecar(dir, { version: 1, titles: { A: { en: "Old" } } });
    saveTitleSidecar(dir, { version: 1, titles: { A: { en: "New" } } });

    const loaded = loadTitleSidecar(dir);
    assert.deepEqual(loaded, { version: 1, titles: { A: { en: "New" } } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── pruneTitleSidecar ────────────────────────────────────────────────────────

test("pruneTitleSidecar: removes stale bases, keeps valid ones", () => {
  const dir = mkTmpDir();
  try {
    saveTitleSidecar(dir, {
      version: 1,
      titles: { Keep: { en: "Keep title" }, Stale: { en: "Stale title" } },
    });

    pruneTitleSidecar(dir, new Set(["Keep"]));

    const loaded = loadTitleSidecar(dir);
    assert.deepEqual(loaded, { version: 1, titles: { Keep: { en: "Keep title" } } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneTitleSidecar: deletes the sidecar file when nothing remains", () => {
  const dir = mkTmpDir();
  try {
    saveTitleSidecar(dir, { version: 1, titles: { Stale: { en: "Stale title" } } });

    pruneTitleSidecar(dir, new Set());

    assert.equal(fs.existsSync(path.join(dir, TITLE_SIDECAR_FILENAME)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneTitleSidecar: is a no-op when the sidecar file doesn't exist", () => {
  const dir = mkTmpDir();
  try {
    assert.doesNotThrow(() => pruneTitleSidecar(dir, new Set(["Anything"])));
    assert.equal(fs.existsSync(path.join(dir, TITLE_SIDECAR_FILENAME)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneTitleSidecar: never throws even for an unwritable path", () => {
  const badDir = path.join(os.tmpdir(), "subsmelt-title-sidecar-prune-nope-" + Date.now());
  assert.doesNotThrow(() => pruneTitleSidecar(badDir, new Set(["Anything"])));
});

// ── getTitle / withTitle ─────────────────────────────────────────────────────

test("getTitle: returns undefined when base or langCode missing", () => {
  const sidecar: TitleSidecar = { version: 1, titles: {} };
  assert.equal(getTitle(sidecar, "Movie", "zh"), undefined);
});

test("getTitle: returns the stored title", () => {
  const sidecar: TitleSidecar = { version: 1, titles: { Movie: { zh: "电影" } } };
  assert.equal(getTitle(sidecar, "Movie", "zh"), "电影");
});

test("withTitle: does not mutate its input", () => {
  const original: TitleSidecar = { version: 1, titles: { Movie: { zh: "电影" } } };
  const snapshot = JSON.parse(JSON.stringify(original));
  const updated = withTitle(original, "Movie", "en", "Movie");
  assert.deepEqual(original, snapshot);
  assert.notEqual(updated, original);
  assert.equal(getTitle(updated, "Movie", "en"), "Movie");
  assert.equal(getTitle(updated, "Movie", "zh"), "电影");
});

test("withTitle: adds a new base entry without disturbing others", () => {
  const original: TitleSidecar = { version: 1, titles: { A: { zh: "甲" } } };
  const updated = withTitle(original, "B", "zh", "乙");
  assert.equal(getTitle(updated, "A", "zh"), "甲");
  assert.equal(getTitle(updated, "B", "zh"), "乙");
});

// ── ensureTranslatedTitle ────────────────────────────────────────────────────

test("ensureTranslatedTitle: skips translation when sidecar already has a title", async () => {
  const dir = mkTmpDir();
  try {
    const seeded: TitleSidecar = {
      version: 1,
      titles: { "Inception.2010.1080p.BluRay.x264-SPARKS": { zh: "盗梦空间" } },
    };
    saveTitleSidecar(dir, seeded);

    let calls = 0;
    const translate = async (text: string) => {
      calls += 1;
      return `translated:${text}`;
    };

    const result = await ensureTranslatedTitle({
      outputDir: dir,
      base: "Inception.2010.1080p.BluRay.x264-SPARKS",
      langCode: "zh",
      translate,
    });

    assert.equal(result, "盗梦空间");
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTranslatedTitle: translates, merges, and saves when no title exists", async () => {
  const dir = mkTmpDir();
  try {
    const translate = async (_text: string) => "全面启动";

    const result = await ensureTranslatedTitle({
      outputDir: dir,
      base: "Inception.2010.1080p.BluRay.x264-SPARKS",
      langCode: "zh",
      translate,
    });

    assert.equal(result, "全面启动");

    const saved = loadTitleSidecar(dir);
    assert.deepEqual(saved, {
      version: 1,
      titles: { "Inception.2010.1080p.BluRay.x264-SPARKS": { zh: "全面启动" } },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTranslatedTitle: rethrows when translate() throws and writes no sidecar", async () => {
  const dir = mkTmpDir();
  try {
    const translate = async (_text: string) => {
      throw new Error("translate failed");
    };

    await assert.rejects(
      ensureTranslatedTitle({
        outputDir: dir,
        base: "Inception.2010.1080p.BluRay.x264-SPARKS",
        langCode: "zh",
        translate,
      }),
      /translate failed/
    );

    assert.equal(fs.existsSync(path.join(dir, TITLE_SIDECAR_FILENAME)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTranslatedTitle: sanitizes the translate() result before caching", async () => {
  const dir = mkTmpDir();
  try {
    const translate = async (_text: string) => '"全面启动"\nNote: this means Inception';

    const result = await ensureTranslatedTitle({
      outputDir: dir,
      base: "Inception.2010.1080p.BluRay.x264-SPARKS",
      langCode: "zh",
      translate,
    });

    assert.equal(result, "全面启动");

    const saved = loadTitleSidecar(dir);
    assert.deepEqual(saved, {
      version: 1,
      titles: { "Inception.2010.1080p.BluRay.x264-SPARKS": { zh: "全面启动" } },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTranslatedTitle: throws when the sanitized title is empty and writes no sidecar", async () => {
  const dir = mkTmpDir();
  try {
    const translate = async (_text: string) => '""';

    await assert.rejects(
      ensureTranslatedTitle({
        outputDir: dir,
        base: "Inception.2010.1080p.BluRay.x264-SPARKS",
        langCode: "zh",
        translate,
      }),
      /empty title from translator/
    );

    assert.equal(fs.existsSync(path.join(dir, TITLE_SIDECAR_FILENAME)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTranslatedTitle: force:true re-translates despite a cached title and overwrites it", async () => {
  const dir = mkTmpDir();
  try {
    const seeded: TitleSidecar = {
      version: 1,
      titles: { "Inception.2010.1080p.BluRay.x264-SPARKS": { zh: "旧标题" } },
    };
    saveTitleSidecar(dir, seeded);

    let calls = 0;
    const translate = async (_text: string) => {
      calls += 1;
      return "新标题";
    };

    const result = await ensureTranslatedTitle({
      outputDir: dir,
      base: "Inception.2010.1080p.BluRay.x264-SPARKS",
      langCode: "zh",
      translate,
      force: true,
    });

    assert.equal(calls, 1);
    assert.equal(result, "新标题");

    const saved = loadTitleSidecar(dir);
    assert.deepEqual(saved, {
      version: 1,
      titles: { "Inception.2010.1080p.BluRay.x264-SPARKS": { zh: "新标题" } },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTranslatedTitle: concurrent calls for different languages both persist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-title-race-"));
  try {
    const slowTranslate = (result: string) => async (_text: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    };
    await Promise.all([
      ensureTranslatedTitle({ outputDir: dir, base: "Movie", langCode: "zh", translate: slowTranslate("电影") }),
      ensureTranslatedTitle({ outputDir: dir, base: "Movie", langCode: "ja", translate: slowTranslate("映画") }),
    ]);
    const sidecar = loadTitleSidecar(dir);
    assert.equal(getTitle(sidecar, "Movie", "zh"), "电影");
    assert.equal(getTitle(sidecar, "Movie", "ja"), "映画");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
