import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { useSettingsQuery, useTasksQuery } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { ActionButton, Drawer } from "../../ui/primitives";
import { getErrorMessage } from "../../lib/errors";
import {
  CORRECTION_MATCH_MODES,
  correctionRuleIssue,
  correctionRuleSetsIssues,
  parseCorrectionRuleSets,
  type CorrectionRule,
  type ScanReport,
} from "../../../shared/corrections";
import { relativeFolder } from "../library/library-model";
import { MatchList, fixable } from "./MatchList";
import { issueText } from "./issues";
import { addRuleForFolder, ancestorFolders, createId, defaultMatchFor, newRule } from "./model";

const CONTROL =
  "w-full rounded-sm border border-border bg-surface-raised px-3 py-2 text-sm text-text focus:border-accent min-h-touch md:min-h-0";
const SMALL =
  "rounded-sm border border-border bg-surface px-2 py-2 text-xs text-text focus:border-accent min-h-touch md:min-h-0";
const NEW_LIST = "\u0000new";

export interface FixDialogProps {
  /** The selected text. */
  find: string;
  /** Which column it was selected in: the source subtitle or its translation. */
  column: "original" | "translated";
  srtPath: string;
  outputPath: string;
  /** The translation's language, by its name in the job (for an output rule's language). */
  targetLang?: string;
  onClose: () => void;
}

/**
 * "Fix everywhere": turn a selected word into a correction. Only this file
 * gets a one-off fix; all files in a folder saves the rule to a list on that
 * folder (so future files get it too) and fixes the existing files the person
 * leaves ticked. A fixed source can have its translations redone.
 */
export function FixDialog({ find: initialFind, column, srtPath, outputPath, targetLang, onClose }: FixDialogProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const settings = (useSettingsQuery().data ?? {}) as Record<string, unknown>;
  const tasks = useTasksQuery().data ?? [];
  const mediaDir = String(settings._media_dir ?? "/media");
  const stage = column === "original" ? "source" : "output";
  const file = stage === "source" ? srtPath : outputPath;
  const langCode = tasks.find((task) => task.target_lang === targetLang)?.lang_code;

  const [find, setFind] = useState(initialFind.trim());
  const [replace, setReplace] = useState("");
  const [match, setMatch] = useState<CorrectionRule["match"]>(() => defaultMatchFor(initialFind));
  const [caseSensitive, setCaseSensitive] = useState(true);
  const folders = useMemo(() => ancestorFolders(relativeFolder(file, mediaDir)), [file, mediaDir]);
  const [scope, setScope] = useState<"file" | "folder">("folder");
  const lists = useMemo(() => parseCorrectionRuleSets(String(settings.correction_rule_sets ?? "[]")), [settings]);
  // Start at the nearest folder that already has a list (a "Sereniti" list on AnKor/ for a file in
  // AnKor/Tutorials/), so the fix joins it; without one, at the file's own folder.
  const [folder, setFolder] = useState(
    () => folders.find((f) => lists.some((list) => list.paths.includes(f))) ?? folders[0] ?? "",
  );
  const replaceRef = useRef<HTMLInputElement>(null);
  // The drawer focuses its first control when it opens; move on to the field to type in.
  useEffect(() => {
    const timer = setTimeout(() => replaceRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  const listsHere = lists.filter((list) => list.paths.includes(folder));
  const [listId, setListId] = useState<string>(NEW_LIST);
  useEffect(() => setListId(listsHere[0]?.id ?? NEW_LIST), [listsHere[0]?.id]);

  const rule: CorrectionRule = useMemo(
    () => ({
      ...newRule(find, replace),
      id: "fix",
      stage,
      match,
      caseSensitive,
      // A fix made in a translation applies to that language only.
      languages: stage === "output" && langCode ? [langCode.toLowerCase()] : [],
    }),
    [find, replace, stage, match, caseSensitive, langCode],
  );
  const ruleIssue = find ? correctionRuleIssue(rule) : null;
  const ruleError = ruleIssue ? issueText(ruleIssue, t, { withRule: false }) : null;
  // A fix needs its correct word: an empty one would delete the term from every ticked file.
  const ready = Boolean(find && replace.trim() && !ruleError);

  const [report, setReport] = useState<ScanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retranslate, setRetranslate] = useState(true);
  const [rememberUnticked, setRememberUnticked] = useState(false);
  const [busy, setBusy] = useState(false);

  // Dry run, debounced while typing: what this rule would change in scope.
  useEffect(() => {
    // Any change of rule or scope makes the last report stale: drop it and its
    // ticks at once, so Fix can never apply a list that no longer matches the form.
    setReport(null);
    setSelected(new Set());
    if (!ready) {
      setScanning(false);
      return;
    }
    let active = true;
    setScanning(true);
    const timer = setTimeout(() => {
      api
        .scanCorrections({ rules: [rule], ...(scope === "file" ? { files: [file] } : { folders: [folder] }) })
        .then((result) => {
          if (!active) return;
          setReport(result);
          setScanError(null);
          setSelected(new Set(result.matches.filter(fixable).map((m) => m.path)));
        })
        .catch((error) => active && setScanError(getErrorMessage(error)))
        .finally(() => active && setScanning(false));
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [rule, ready, scope, folder, file]);

  const chosen = report?.matches.filter((m) => selected.has(m.path)) ?? [];
  // Files the person unticked; with "remember", the saved rule leaves them alone for good.
  const unticked = report?.matches.filter((m) => fixable(m) && !selected.has(m.path)) ?? [];
  const jobs = chosen.flatMap((m) => m.jobs);
  const tokens = jobs.reduce((sum, job) => sum + job.tokens, 0);
  const offerRetranslate = stage === "source" && jobs.length > 0;
  const folderLabel = (f: string) => (f === "" ? t("settings.corrections.wholeLibrary") : f);

  const submit = async () => {
    if (!ready || scanning) return;
    setBusy(true);
    try {
      if (scope === "folder") {
        const name = folder.split("/").pop() || t("settings.corrections.newListName");
        const next = addRuleForFolder(
          lists,
          folder,
          listId === NEW_LIST ? null : listId,
          {
            ...rule,
            id: createId(),
            ...(rememberUnticked && unticked.length ? { except: unticked.map((m) => m.relative) } : {}),
          },
          name,
        );
        const json = JSON.stringify(next);
        const issues = correctionRuleSetsIssues(json);
        if (issues.length) throw new Error(issueText(issues[0], t));
        await api.saveSettings({ correction_rule_sets: json });
      }
      const files = chosen.map((m) => m.path);
      const result = files.length
        ? await api.applyCorrections({ rules: [rule], files, retranslate: offerRetranslate && retranslate })
        : { totalFixed: 0, retranslated: 0, results: [] };
      const failed = result.results.filter((r) => r.error).length;
      addToast(
        [
          t("corrections.fix.doneFixed", {
            count: result.totalFixed,
            files: result.results.filter((r) => r.total).length,
          }),
          scope === "folder" ? t("corrections.fix.doneSaved", { folder: folderLabel(folder) }) : "",
          result.retranslated ? t("corrections.fix.doneRetranslate", { count: result.retranslated }) : "",
          failed ? t("corrections.fix.doneFailed", { count: failed }) : "",
        ]
          .filter(Boolean)
          .join(" "),
        failed ? "error" : "success",
      );
      await Promise.all(
        ["settings", "job-preview", "jobs", "library"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );
      onClose();
    } catch (error) {
      addToast(t("settings.saveFailed", { message: getErrorMessage(error) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const submitLabel =
    scope === "folder" && chosen.length === 0
      ? t("corrections.fix.saveOnly")
      : t("corrections.fix.submit", { count: chosen.length });

  return (
    <Drawer open onClose={onClose} title={t("corrections.fix.title")} width="max-w-2xl">
      <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-end">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">{t("settings.corrections.quickFind")}</span>
            <input value={find} onChange={(e) => setFind(e.target.value)} className={`${CONTROL} font-mono`} />
          </label>
          <span aria-hidden="true" className="hidden pb-2 text-faint md:block">
            →
          </span>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">{t("settings.corrections.quickReplace")}</span>
            <input
              ref={replaceRef}
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              className={`${CONTROL} font-mono`}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span>
            {t(stage === "source" ? "corrections.fix.inSource" : "corrections.fix.inTranslation", {
              lang: langCode ?? targetLang ?? "",
            })}
          </span>
          <select
            value={match}
            aria-label={t("settings.corrections.match")}
            onChange={(e) => setMatch(e.target.value as CorrectionRule["match"])}
            className={SMALL}
          >
            {CORRECTION_MATCH_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`settings.corrections.match_${mode}`)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            {t("settings.corrections.caseSensitive")}
          </label>
        </div>
        {ruleError && <p className="text-xs text-danger">{ruleError}</p>}
        {!ruleError && find && !replace.trim() && (
          <p className="text-xs text-muted">{t("corrections.fix.typeReplacement")}</p>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-muted">{t("corrections.fix.applyTo")}</legend>
          <label className="flex items-start gap-2 text-sm text-text">
            <input
              type="radio"
              name="fix-scope"
              checked={scope === "file"}
              onChange={() => setScope("file")}
              className="mt-1 accent-accent"
            />
            <span>
              {t("corrections.fix.onlyThisFile")}
              <span className="block text-xs text-muted">{t("corrections.fix.onlyThisFileHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-text">
            <input
              type="radio"
              name="fix-scope"
              checked={scope === "folder"}
              onChange={() => setScope("folder")}
              className="mt-1 accent-accent"
            />
            <span className="min-w-0 flex-1 space-y-2">
              <span className="flex flex-wrap items-center gap-2">
                {t("corrections.fix.allFilesIn")}
                <select
                  value={folder}
                  aria-label={t("corrections.fix.folder")}
                  onChange={(e) => {
                    setFolder(e.target.value);
                    setScope("folder");
                  }}
                  className={SMALL}
                >
                  {folders.map((f) => (
                    <option key={f || "\u0001"} value={f}>
                      {folderLabel(f)}
                    </option>
                  ))}
                </select>
              </span>
              {scope === "folder" && (
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {t("corrections.fix.saveTo")}
                  <select
                    value={listId}
                    aria-label={t("corrections.fix.saveTo")}
                    onChange={(e) => setListId(e.target.value)}
                    className={SMALL}
                  >
                    {listsHere.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name || t("settings.corrections.untitled")}
                      </option>
                    ))}
                    <option value={NEW_LIST}>
                      {t("corrections.fix.newList", {
                        name: folder.split("/").pop() || t("settings.corrections.newListName"),
                      })}
                    </option>
                  </select>
                  <span className="text-faint">{t("corrections.fix.futureFiles")}</span>
                </span>
              )}
            </span>
          </label>
        </fieldset>

        <div className="space-y-2">
          {scanning && !report && <p className="text-xs text-muted">{t("corrections.fix.scanning")}</p>}
          {scanError && <p className="text-xs text-danger">{scanError}</p>}
          {report && <MatchList report={report} selected={selected} onChange={setSelected} />}
          {scope === "folder" && unticked.length > 0 && (
            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={rememberUnticked}
                onChange={(e) => setRememberUnticked(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-accent"
              />
              {t("corrections.fix.rememberUnticked", { count: unticked.length })}
            </label>
          )}
        </div>

        {offerRetranslate && (
          <label className="flex items-start gap-2 rounded-sm border border-border bg-surface-raised p-3 text-sm text-text">
            <input
              type="checkbox"
              checked={retranslate}
              onChange={(e) => setRetranslate(e.target.checked)}
              className="mt-1 h-4 w-4 accent-accent"
            />
            <span>
              {t("corrections.fix.retranslate", { count: jobs.length })}
              <span className="block text-xs text-muted">
                {tokens > 0
                  ? t("corrections.fix.retranslateCost", { tokens: tokens.toLocaleString() })
                  : t("corrections.fix.retranslateHint")}
              </span>
            </span>
          </label>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <ActionButton variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </ActionButton>
          <ActionButton
            onClick={() => void submit()}
            busy={busy}
            disabled={!ready || scanning || (scope === "file" && chosen.length === 0)}
          >
            {submitLabel}
          </ActionButton>
        </div>
      </div>
    </Drawer>
  );
}
