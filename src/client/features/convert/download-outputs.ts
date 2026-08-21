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
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Map<string, number>();
  for (const out of files) {
    const count = used.get(out.name) ?? 0;
    used.set(out.name, count + 1);
    const dot = out.name.lastIndexOf(".");
    const entryName =
      count === 0
        ? out.name
        : dot > 0
          ? `${out.name.slice(0, dot)}(${count})${out.name.slice(dot)}`
          : `${out.name}(${count})`;
    zip.file(entryName, out.content);
  }
  return zip.generateAsync({ type: "blob" });
}
