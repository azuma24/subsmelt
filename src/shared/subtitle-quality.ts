export interface SubtitleQualityIssue {
  code: "noCues" | "invalidTiming" | "empty" | "short" | "long" | "lines" | "width" | "speed" | "overlap";
  cue?: number;
  line?: number;
  value?: number;
  limit?: number;
}
