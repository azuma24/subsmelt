const EMBEDDED_VIDEO = /\.(mkv|mp4|m4v|mov|webm)$/i;

export function canProbeEmbeddedSubtitles(videoPath: string): boolean {
  return EMBEDDED_VIDEO.test(videoPath);
}

export interface EmbeddedSubtitleTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isBitmap: boolean;
  format: "srt" | "ass" | "ssa" | "vtt" | null;
}

export interface EmbeddedSubtitleProbe {
  revision: string;
  tracks: EmbeddedSubtitleTrack[];
}

export interface EmbeddedSubtitleImport {
  file: string;
}
