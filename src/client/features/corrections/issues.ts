import type { CorrectionIssue } from "../../../shared/corrections";

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** An issue in the viewer's language, prefixed with the list and rule it is about. */
export function issueText(issue: CorrectionIssue, t: Translate, { withRule = true } = {}): string {
  const message = t(`settings.corrections.issue.${issue.code}`, {
    detail: issue.detail ?? "",
    lists: (issue.lists ?? []).map((name) => `“${name}”`).join(", "),
    folder: issue.folder ? issue.folder : t("settings.corrections.wholeLibrary"),
    find: issue.find ?? "",
  });
  if (!withRule || issue.code === "listsConflict") return message;
  const where = [issue.list, issue.find ? `“${issue.find}”` : undefined].filter(Boolean).join(" · ");
  return where ? `${where}: ${message}` : message;
}
