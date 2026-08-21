/**
 * Responsive rules for the file tree, kept pure so they are testable without
 * a DOM. The breakpoint mirrors useIsMobile's media query (max-width: 767px).
 */

export const MOBILE_BREAKPOINT_PX = 768;
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;

/** Horizontal indent per nesting level. */
export const INDENT_PER_LEVEL_PX = 16;

/** On mobile, visual indentation caps here and deeper folders drill down instead. */
export const MOBILE_MAX_INLINE_DEPTH = 2;

export function indentPx(depth: number, isMobile: boolean): number {
  const effective = isMobile ? Math.min(depth, MOBILE_MAX_INLINE_DEPTH) : depth;
  return effective * INDENT_PER_LEVEL_PX;
}

export type FolderRowMode = "inline" | "drill";

/** Inline expandable row, or (mobile, deep) a row that navigates into the folder. */
export function folderRowMode(depth: number, isMobile: boolean): FolderRowMode {
  return isMobile && depth >= MOBILE_MAX_INLINE_DEPTH ? "drill" : "inline";
}
