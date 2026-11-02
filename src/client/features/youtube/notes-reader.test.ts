import { test } from "node:test";
import assert from "node:assert/strict";
import { readableNoteMarkdown } from "./notes-reader.js";

test("reader hides generated frontmatter and the video embed but keeps timestamp links", () => {
  const note =
    '---\ntitle: "Example"\nvideo_id: abcdefghijk\n---\n\n# Example\n\n![](https://www.youtube.com/watch?v=abcdefghijk)\n\n## Transcript\n\n[03:42](https://youtu.be/abcdefghijk?t=222) Hello';
  const text = readableNoteMarkdown(note);
  assert.equal(text.includes("video_id:"), false);
  assert.equal(text.includes("# Example"), false);
  assert.equal(text.includes("![]("), false);
  assert.match(text, /\[03:42\]\(https:\/\/youtu\.be\/abcdefghijk\?t=222\)/);
});

test("reader leaves arbitrary Markdown without frontmatter intact", () => {
  assert.equal(readableNoteMarkdown("# Note\n\nBody"), "# Note\n\nBody");
});
