/**
 * Charset sniffing (jschardet) and language detection (franc-min) are the two
 * heavy libraries in the converter. Loading them on the first dropped file
 * keeps them out of the Convert page's own chunk, so the page opens at once
 * and the libraries only download when a file actually needs them.
 */

export async function readSubtitleFile(file: Blob): Promise<string> {
  const { readSubtitleFile: read } = await import("./decode-text");
  return read(file);
}

export async function detectSampleLanguage(sample: string): Promise<string | null> {
  const { detectSampleLanguage: detect } = await import("./detect-language");
  return detect(sample);
}
