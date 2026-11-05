import { useMemo, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "../../i18n";
import { Field } from "../../ui/primitives";
import {
  CORRECTION_MATCH_MODES,
  CORRECTION_STAGES,
  compileCorrectionsFor,
  correctCueText,
  correctionRuleError,
  totalCorrections,
  type CorrectionRule,
  type CorrectionRuleSet,
} from "../../../shared/corrections";
import { lowercaseTwin, newRule, parseQuickAdd, ruleTags } from "./model";

const SMALL =
  "rounded-sm border border-border bg-surface px-2 py-2 text-xs text-text focus:border-accent min-h-touch md:min-h-0";
const TAG = "rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[11px] text-muted";
const LINK = "rounded-sm px-2 py-1 text-xs text-faint hover:text-text";

interface ListEditorProps {
  list: CorrectionRuleSet;
  onChange: (list: CorrectionRuleSet) => void;
  onDelete?: () => void;
  /** Media folders to offer; omit to hide the folder picker (the Library panel sets the folder itself). */
  folders?: string[];
  /** Target language codes of the configured tasks, for "after translation" rules. */
  langCodes: string[];
}

/**
 * One correction list: its name, folders and rules. A rule is one line,
 * `find → replace`, with tags only for options that differ from the defaults
 * (before translation, whole word, match case); its options open on demand.
 * New rules are typed or pasted into the last line.
 */
export function ListEditor({ list, onChange, onDelete, folders, langCodes }: ListEditorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const [twinFor, setTwinFor] = useState<string | null>(null);

  const setRules = (rules: CorrectionRule[]) => onChange({ ...list, rules });
  const updateRule = (id: string, patch: Partial<CorrectionRule>) =>
    setRules(list.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  const addRules = (pairs: Array<{ find: string; replace: string }>) => {
    const added = pairs.map(({ find, replace }) => newRule(find, replace));
    setRules([...list.rules, ...added]);
    // A single typed rule gets the lowercase-twin offer; a pasted batch is taken as it is.
    setTwinFor(added.length === 1 ? added[0].id : null);
  };

  const twinRule = list.rules.find((rule) => rule.id === twinFor);
  const twin = twinRule ? lowercaseTwin(twinRule, list.rules) : null;

  return (
    <section className="space-y-3 rounded-md border border-border bg-surface-raised p-3">
      <header className="flex flex-wrap items-center gap-2">
        <input
          value={list.name}
          onChange={(e) => onChange({ ...list, name: e.target.value })}
          placeholder={t("settings.corrections.listNamePlaceholder")}
          aria-label={t("settings.corrections.listName")}
          className="min-w-[160px] flex-1 rounded-sm border border-transparent bg-transparent px-1 py-1 text-sm font-semibold text-text hover:border-border focus:border-accent"
        />
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={list.enabled}
            onChange={(e) => onChange({ ...list, enabled: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
          {t("settings.corrections.enabled")}
        </label>
        {onDelete && (
          <button type="button" onClick={onDelete} className={`${LINK} hover:text-danger`}>
            {t("settings.corrections.deleteList")}
          </button>
        )}
      </header>

      {folders && <FolderPicker list={list} folders={folders} onChange={onChange} />}

      <ul className="divide-y divide-border-subtle rounded-sm border border-border bg-surface">
        {list.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            open={open === rule.id}
            onToggleOpen={() => setOpen(open === rule.id ? null : rule.id)}
            onChange={(patch) => updateRule(rule.id, patch)}
            onDelete={() => setRules(list.rules.filter((r) => r.id !== rule.id))}
            langCodes={langCodes}
          />
        ))}
        <li>
          <QuickAdd onAdd={addRules} />
        </li>
      </ul>

      {twin && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {t("settings.corrections.twinOffer", { find: twin.find, replace: twin.replace })}
          <button
            type="button"
            onClick={() => {
              setRules([...list.rules, newRule(twin.find, twin.replace)]);
              setTwinFor(null);
            }}
            className="rounded-sm border border-accent-line bg-accent-soft px-2 py-0.5 text-accent"
          >
            {t("settings.corrections.twinAdd")}
          </button>
          <button type="button" onClick={() => setTwinFor(null)} className={LINK}>
            {t("settings.corrections.twinDismiss")}
          </button>
        </p>
      )}

      <TryLine list={list} />
    </section>
  );
}

function FolderPicker({
  list,
  folders,
  onChange,
}: {
  list: CorrectionRuleSet;
  folders: string[];
  onChange: (list: CorrectionRuleSet) => void;
}) {
  const { t } = useTranslation();
  const label = (folder: string) => (folder === "" ? t("settings.corrections.wholeLibrary") : folder);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">{t("settings.corrections.appliesTo")}</span>
      {list.paths.length === 0 && <span className="text-xs text-warning">{t("settings.corrections.noFolder")}</span>}
      {list.paths.map((folder) => (
        <span
          key={folder}
          className="inline-flex items-center gap-1 rounded-full border border-accent-line bg-accent-soft px-3 py-1 text-xs text-accent"
        >
          {label(folder)}
          <button
            type="button"
            aria-label={t("settings.corrections.removeFolder", { folder: label(folder) })}
            onClick={() => onChange({ ...list, paths: list.paths.filter((p) => p !== folder) })}
            className="text-faint hover:text-danger"
          >
            ×
          </button>
        </span>
      ))}
      <select
        // A placeholder value no folder can have, so every real folder (the root "" too) is pickable.
        value="\u0000"
        aria-label={t("settings.corrections.addFolder")}
        onChange={(e) => {
          const folder = e.target.value;
          if (folder !== "\u0000" && !list.paths.includes(folder))
            onChange({ ...list, paths: [...list.paths, folder] });
        }}
        className={`min-w-0 max-w-full ${SMALL}`}
      >
        <option value={"\u0000"}>{t("settings.corrections.addFolder")}</option>
        {["", ...folders]
          .filter((folder) => !list.paths.includes(folder))
          .map((folder) => (
            <option key={folder || "\u0001"} value={folder}>
              {label(folder)}
            </option>
          ))}
      </select>
    </div>
  );
}

function RuleRow({
  rule,
  open,
  onToggleOpen,
  onChange,
  onDelete,
  langCodes,
}: {
  rule: CorrectionRule;
  open: boolean;
  onToggleOpen: () => void;
  onChange: (patch: Partial<CorrectionRule>) => void;
  onDelete: () => void;
  langCodes: string[];
}) {
  const { t } = useTranslation();
  const error = rule.find ? correctionRuleError(rule) : t("settings.corrections.findEmpty");
  return (
    <li className={`px-2 py-1 ${rule.enabled ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={rule.enabled}
          aria-label={t("settings.corrections.ruleEnabled")}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="h-4 w-4 accent-accent"
        />
        <input
          value={rule.find}
          onChange={(e) => onChange({ find: e.target.value })}
          aria-label={t("settings.corrections.find")}
          aria-invalid={Boolean(error)}
          className={`min-w-[100px] flex-1 font-mono ${SMALL} ${error ? "border-danger-line" : ""}`}
        />
        <span aria-hidden="true" className="text-xs text-faint">
          →
        </span>
        <input
          value={rule.replace}
          onChange={(e) => onChange({ replace: e.target.value })}
          aria-label={t("settings.corrections.replace")}
          className={`min-w-[100px] flex-1 font-mono ${SMALL}`}
        />
        <span className="flex flex-wrap gap-1">
          {ruleTags(rule).map((tag) => (
            <span key={tag} className={TAG}>
              {tag === "langs" ? rule.languages.join(", ") : t(`settings.corrections.tag_${tag}`)}
            </span>
          ))}
        </span>
        <button type="button" onClick={onToggleOpen} aria-expanded={open} className={LINK}>
          {t("settings.corrections.options")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={t("settings.corrections.deleteRule", { find: rule.find })}
          className={`${LINK} hover:text-danger`}
        >
          ×
        </button>
      </div>
      {open && <RuleOptions rule={rule} onChange={onChange} langCodes={langCodes} />}
      {error && <p className="px-6 pb-1 text-xs text-danger">{error}</p>}
    </li>
  );
}

function RuleOptions({
  rule,
  onChange,
  langCodes,
}: {
  rule: CorrectionRule;
  onChange: (patch: Partial<CorrectionRule>) => void;
  langCodes: string[];
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 pl-6">
      <label className="flex items-center gap-1 text-xs text-muted">
        {t("settings.corrections.stage")}
        <select
          value={rule.stage}
          onChange={(e) => onChange({ stage: e.target.value as CorrectionRule["stage"] })}
          className={SMALL}
        >
          {CORRECTION_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {t(`settings.corrections.stage_${stage}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-muted">
        {t("settings.corrections.match")}
        <select
          value={rule.match}
          onChange={(e) => onChange({ match: e.target.value as CorrectionRule["match"] })}
          className={SMALL}
        >
          {CORRECTION_MATCH_MODES.map((match) => (
            <option key={match} value={match}>
              {t(`settings.corrections.match_${match}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={rule.caseSensitive}
          onChange={(e) => onChange({ caseSensitive: e.target.checked })}
          className="h-4 w-4 accent-accent"
        />
        {t("settings.corrections.caseSensitive")}
      </label>
      {rule.stage !== "source" && (langCodes.length > 0 || rule.languages.length > 0) && (
        <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
          {t("settings.corrections.languages")}
          {Array.from(new Set([...langCodes.map((code) => code.toLowerCase()), ...rule.languages])).map((code) => {
            const value = code;
            const on = rule.languages.includes(value);
            return (
              <button
                key={code}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange({ languages: on ? rule.languages.filter((l) => l !== value) : [...rule.languages, value] })
                }
                className={`rounded-full border px-2 py-0.5 ${on ? "border-accent-line bg-accent-soft text-accent" : "border-border text-muted"}`}
              >
                {code}
              </button>
            );
          })}
          {rule.languages.length === 0 && (
            <span className="text-faint">({t("settings.corrections.allLanguages")})</span>
          )}
        </span>
      )}
    </div>
  );
}

/** The always-present last line: type a pair and press Enter, or paste many lines of `find → replace`. */
function QuickAdd({ onAdd }: { onAdd: (pairs: Array<{ find: string; replace: string }>) => void }) {
  const { t } = useTranslation();
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const submit = () => {
    if (!find.trim()) return;
    onAdd([{ find: find.trim(), replace: replace.trim() }]);
    setFind("");
    setReplace("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pairs = parseQuickAdd(event.clipboardData.getData("text"));
    if (pairs.length === 0) return;
    event.preventDefault();
    onAdd(pairs);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-2">
      <span aria-hidden="true" className="w-4 text-center text-xs text-faint">
        +
      </span>
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={t("settings.corrections.quickFind")}
        aria-label={t("settings.corrections.quickFind")}
        className={`min-w-[100px] flex-1 font-mono ${SMALL}`}
      />
      <span aria-hidden="true" className="text-xs text-faint">
        →
      </span>
      <input
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("settings.corrections.quickReplace")}
        aria-label={t("settings.corrections.quickReplace")}
        className={`min-w-[100px] flex-1 font-mono ${SMALL}`}
      />
      <button type="button" onClick={submit} disabled={!find.trim()} className={`${LINK} disabled:opacity-40`}>
        {t("settings.corrections.addRule")}
      </button>
      <p className="w-full pl-6 text-[11px] text-faint">{t("settings.corrections.quickHint")}</p>
    </div>
  );
}

/** Runs the list's rules on a typed line, with the same code the server uses. */
function TryLine({ list }: { list: CorrectionRuleSet }) {
  const { t } = useTranslation();
  const [line, setLine] = useState("");
  const [stage, setStage] = useState<"source" | "output">("source");
  const result = useMemo(() => {
    // Every rule of the stage, whatever its folders and languages: this previews the list itself.
    const preview = {
      ...list,
      enabled: true,
      paths: [""],
      rules: list.rules.map((rule) => ({ ...rule, languages: [] })),
    };
    return correctCueText(line, compileCorrectionsFor([preview], "", stage));
  }, [list, line, stage]);
  const count = totalCorrections(result.counts);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer py-1 text-muted hover:text-text">{t("settings.corrections.tryLine")}</summary>
      <div className="space-y-2 pt-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <Field
              label={t("settings.corrections.tryLine")}
              value={line}
              onChange={setLine}
              placeholder={t("settings.corrections.tryLinePlaceholder")}
            />
          </div>
          <select
            value={stage}
            aria-label={t("settings.corrections.stage")}
            onChange={(e) => setStage(e.target.value as "source" | "output")}
            className={SMALL}
          >
            <option value="source">{t("settings.corrections.stage_source")}</option>
            <option value="output">{t("settings.corrections.stage_output")}</option>
          </select>
        </div>
        {line && (
          <p className="break-words font-mono text-muted">
            → {result.text} <span className="text-faint">({t("settings.corrections.replacements", { count })})</span>
          </p>
        )}
      </div>
    </details>
  );
}
