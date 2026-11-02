export function readableNoteMarkdown(content: string): string {
  const generated = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(content);
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  // The generated Obsidian embed points at a watch page, not an image. The
  // reader already has an explicit Open on YouTube link above the document.
  return (generated ? withoutFrontmatter.replace(/^\s*# [^\n]+\r?\n/, "") : withoutFrontmatter)
    .replace(/^!\[\]\(https:\/\/(?:www\.)?youtube\.com\/watch\?v=[^\n)]*\)\s*\r?\n?/gm, "")
    .trim();
}
