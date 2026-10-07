import type { Job, Task, TaskStatus } from "./types";

/**
 * Whole API objects for tests, so a fixture names only what the test is
 * about. The defaults are what a fresh, idle row looks like.
 */
export function makeJob(partial: Partial<Job> & Pick<Job, "id">): Job {
  return {
    task_id: 1,
    srt_path: "",
    output_path: "",
    video_path: null,
    status: "pending",
    priority: 0,
    force: 0,
    total_cues: 0,
    completed_cues: 0,
    error: null,
    used_connections: null,
    duration_seconds: null,
    input_tokens: 0,
    output_tokens: 0,
    est_cost: null,
    started_at: null,
    created_at: null,
    updated_at: null,
    target_lang: "",
    lang_code: "",
    source_lang: "",
    connection: null,
    ...partial,
  };
}

export function makeTask(partial: Partial<Task> & Pick<Task, "id">): Task {
  return {
    source_lang: "Automatic",
    target_lang: "",
    output_pattern: "{{name}}.{{lang_code}}.srt",
    lang_code: "",
    enabled: 1,
    prompt_override: "",
    created_at: "2026-01-01 00:00:00",
    ...partial,
  };
}

export function makeTaskStatus(
  partial: Partial<TaskStatus> & Pick<TaskStatus, "taskId" | "langCode" | "targetLang" | "status">,
): TaskStatus {
  return { outputName: "", outputPath: "", jobId: null, translatedTitle: null, outputExists: false, ...partial };
}
