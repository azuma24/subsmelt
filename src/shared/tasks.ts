/** A translation task: one target language with its output naming. Stored in config.json. */
export interface TranslationTask {
  id: number;
  source_lang: string;
  target_lang: string;
  output_pattern: string;
  lang_code: string;
  /** Codes this task wrote before it moved to the standard one; outputs named with them still count. */
  former_lang_codes?: string[];
  enabled: number;
  prompt_override: string;
  created_at: string;
}
