export const ACCEPTED_EXTS = ["srt", "vtt", "ass", "ssa"] as const;
export const ACCEPT_ATTR = ACCEPTED_EXTS.map((e) => `.${e}`).join(",");

export interface OutputFile {
  name: string;
  content: string;
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isSupported(name: string): boolean {
  return (ACCEPTED_EXTS as readonly string[]).includes(extOf(name));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Revoke on next tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function buildZipBlob(files: OutputFile[]): Promise<Blob> {
  const { buildZip } = await import("./zip");
  // Reserve the original names so an earlier duplicate cannot claim a later file's name.
  const reserved = new Set(files.map(({ name }) => name));
  const nextSuffix = new Map<string, number>();
  const entries = files.map(({ name, content }) => {
    let suffix = nextSuffix.get(name);
    if (suffix === undefined) {
      nextSuffix.set(name, 1);
      return { name, content };
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let uniqueName: string;
    do {
      uniqueName = `${stem}(${suffix})${extension}`;
      suffix++;
    } while (reserved.has(uniqueName));
    reserved.add(uniqueName);
    nextSuffix.set(name, suffix);
    return { name: uniqueName, content };
  });
  return buildZip(entries);
}
