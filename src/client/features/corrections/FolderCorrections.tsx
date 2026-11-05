import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../../i18n";
import * as api from "../../api";
import { useSettingsQuery, useTasksQuery } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { Drawer } from "../../ui/primitives";
import { getErrorMessage } from "../../lib/errors";
import { flattenFolderTree } from "../settings/media-sources/model";
import { correctionRuleSetsErrors, parseCorrectionRuleSets, type CorrectionRuleSet } from "../../../shared/corrections";
import { ListEditor } from "./ListEditor";
import { listFolder, listsForFolder, newList, setListForFolder } from "./model";
import { SaveBar } from "./SaveBar";
import { useCorrectionDraft } from "./useCorrectionDraft";

const HEADING = "text-xs font-semibold uppercase tracking-wide text-muted";
const SECONDARY =
  "inline-flex min-h-touch items-center justify-center gap-2 rounded-sm border border-border bg-surface px-3 text-sm font-medium text-text transition-colors duration-fast hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-45";

/**
 * The Library panel's "Corrections" block: which correction lists apply to
 * this file's folder, switched on or off here with one click, and a drawer to
 * edit a list or start one for the folder.
 */
export function FolderCorrections({ folder: rawFolder }: { folder: string }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const settingsQuery = useSettingsQuery();
  const saved = String((settingsQuery.data as Record<string, unknown> | undefined)?.correction_rule_sets ?? "[]");
  const folder = listFolder(rawFolder);
  const savedLists = useMemo(() => parseCorrectionRuleSets(saved), [saved]);
  // A switched list shows its new state at once; the saved value replaces it when the save lands.
  const [optimistic, setOptimistic] = useState<CorrectionRuleSet[] | null>(null);
  const lists = optimistic ?? savedLists;
  const rows = useMemo(() => listsForFolder(lists, folder), [lists, folder]);
  const [editing, setEditing] = useState<CorrectionRuleSet | null>(null);
  const [busy, setBusy] = useState(false);

  const persist = async (json: string) => {
    try {
      await api.saveSettings({ correction_rule_sets: json });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      addToast(t("settings.saveFailed", { message: getErrorMessage(error) }), "error");
      throw error;
    }
  };

  const toggle = async (listId: string, on: boolean) => {
    const next = setListForFolder(lists, listId, folder, on);
    const json = JSON.stringify(next);
    const errors = correctionRuleSetsErrors(json);
    // Switching a list off for its only folder leaves it with none, which a save refuses; say so instead.
    if (errors.length) return addToast(errors[0], "error");
    setBusy(true);
    setOptimistic(next);
    try {
      await persist(json);
    } catch {
      // Toasted in persist; dropping the optimistic state puts the box back.
    } finally {
      setOptimistic(null);
      setBusy(false);
    }
  };

  const folderLabel = folder === "" ? t("settings.corrections.wholeLibrary") : folder;
  const active = rows.filter((row) => row.list.enabled && (row.direct || row.inheritedFrom !== null));

  return (
    <section className="space-y-3">
      <h3 className={HEADING}>{t("library.corrections.title")}</h3>
      {lists.length === 0 ? (
        <p className="text-sm text-muted">{t("library.corrections.none")}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map(({ list, direct, inheritedFrom }) => {
            const inherited = !direct && inheritedFrom !== null;
            return (
              <li key={list.id} className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={direct || inherited}
                    disabled={busy || inherited || !list.enabled}
                    onChange={(e) => void toggle(list.id, e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span className={`truncate ${list.enabled ? "text-text" : "text-faint line-through"}`}>
                    {list.name || t("settings.corrections.untitled")}
                  </span>
                  <span className="shrink-0 text-xs text-faint">
                    {t("library.corrections.ruleCount", { count: list.rules.length })}
                    {inherited &&
                      ` · ${t("library.corrections.from", {
                        folder: inheritedFrom === "" ? t("settings.corrections.wholeLibrary") : inheritedFrom,
                      })}`}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => setEditing(list)}
                  className="rounded-sm px-2 py-1 text-xs text-accent hover:underline"
                >
                  {t("library.corrections.edit")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {lists.length > 0 && active.length === 0 && (
        <p className="text-xs text-faint">{t("library.corrections.noneActive", { folder: folderLabel })}</p>
      )}
      <button
        type="button"
        className={SECONDARY}
        onClick={() => setEditing(newList(folder === "" ? t("settings.corrections.newListName") : folder, folder))}
      >
        {t("library.corrections.newForFolder")}
      </button>
      {editing && (
        <EditDrawer lists={lists} saved={saved} initial={editing} onClose={() => setEditing(null)} persist={persist} />
      )}
    </section>
  );
}

/** Edits one list (new or existing) in a drawer, saving it into the whole setting. */
function EditDrawer({
  lists,
  saved,
  initial,
  onClose,
  persist,
}: {
  lists: CorrectionRuleSet[];
  saved: string;
  initial: CorrectionRuleSet;
  onClose: () => void;
  persist: (json: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const tasksQuery = useTasksQuery();
  const [folders, setFolders] = useState<string[]>([]);
  const isNew = !lists.some((list) => list.id === initial.id);
  // The draft is the whole setting, with a new list already in it, so validation sees everything a save sends.
  const draft = useCorrectionDraft(saved, async (json) => {
    await persist(json);
    onClose();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeds a new list into the draft once
  useEffect(() => {
    if (isNew) draft.setLists((current) => [...current, initial]);
  }, []);
  useEffect(() => {
    let active = true;
    api
      .getFolderTree()
      .then((data) => active && setFolders(flattenFolderTree(data.root.children)))
      .catch(() => active && setFolders([]));
    return () => {
      active = false;
    };
  }, []);
  const list = draft.lists.find((l) => l.id === initial.id) ?? initial;
  const langCodes = Array.from(new Set((tasksQuery.data ?? []).map((task) => task.lang_code))).sort();

  return (
    <Drawer open onClose={onClose} title={list.name || t("settings.corrections.untitled")} width="max-w-2xl">
      <div className="space-y-4">
        <ListEditor
          list={list}
          folders={folders}
          langCodes={langCodes}
          onChange={(next) => draft.setLists((current) => current.map((l) => (l.id === next.id ? next : l)))}
          onDelete={
            isNew
              ? undefined
              : () => {
                  draft.setLists((current) => current.filter((l) => l.id !== initial.id));
                }
          }
        />
        <SaveBar draft={draft} />
      </div>
    </Drawer>
  );
}
