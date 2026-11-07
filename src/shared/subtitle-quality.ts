export interface SubtitleQualityIssue {
  code:
    | "noCues"
    | "invalidTiming"
    | "empty"
    | "missingCue"
    | "short"
    | "long"
    | "lines"
    | "width"
    | "speed"
    | "overlap";
  cue?: number;
  line?: number;
  value?: number;
  limit?: number;
}

export function isPlaybackSuggestion({ code }: SubtitleQualityIssue): boolean {
  return code !== "noCues" && code !== "invalidTiming" && code !== "empty" && code !== "missingCue";
}
