import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import * as api from "../../../api";
import type { Task } from "../../../types";
import { ActionButton } from "../../../ui/primitives";
import { str } from "../../../lib/settings-value";
import { useSettingsQuery } from "../../../hooks";
import { flattenFolderTree } from "../media-sources/model";
import { ListEditor } from "../../corrections/ListEditor";
import { newList } from "../../corrections/model";
import { SaveBar } from "../../corrections/SaveBar";
import { useCorrectionDraft } from "../../corrections/useCorrectionDraft";

interface CorrectionsSectionProps {
  settings: Record<string, unknown>;
  /** Resolves to "saved" only when the server stored the whole form. */
  updateAndSave: (key: string, value: unknown) => Promise<string>;
}

/**
 * Settings → Corrections: every correction list, its folders and rules. The
 * Library's file panel switches lists on for a folder; this is the overview
 * and the place to edit lists in bulk.
 */
export function CorrectionsSection({ settings, updateAndSave }: CorrectionsSectionProps) {
  const { t } = useTranslation();
  // The saved value is the server's, not the page form's: the form holds edits the
  // moment they are made, so reading it would mark a failed save as saved.
  const serverSettings = useSettingsQuery().data as Record<string, unknown> | undefined;
  const draft = useCorrectionDraft(
    str(serverSettings?.correction_rule_sets ?? settings.correction_rule_sets, "[]"),
    async (json) => {
      const outcome = await updateAndSave("correction_rule_sets", json);
      // The page has already said why (a toast, or the topbar's unsaved state); keep the draft unsaved.
      if (outcome !== "saved") throw new Error(outcome);
    },
  );
  const [folders, setFolders] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    let active = true;
    api
      .getFolderTree()
      .then((data) => active && setFolders(flattenFolderTree(data.root.children)))
      .catch(() => active && setFolders([]));
    api
      .getTasks()
      .then((data) => active && setTasks(data))
      .catch(() => active && setTasks([]));
    return () => {
      active = false;
    };
  }, []);
  const langCodes = useMemo(() => Array.from(new Set(tasks.map((task) => task.lang_code))).sort(), [tasks]);

  return (
    <div className="space-y-4">
      <p className="text-xs leading-6 text-faint">{t("settings.corrections.hint")}</p>
      {draft.lists.length === 0 && <p className="text-xs text-faint">{t("settings.corrections.noLists")}</p>}
      {draft.lists.map((list) => (
        <ListEditor
          key={list.id}
          list={list}
          folders={folders}
          langCodes={langCodes}
          saved={!draft.dirty}
          onChange={(next) => draft.setLists((lists) => lists.map((l) => (l.id === list.id ? next : l)))}
          onDelete={() => draft.setLists((lists) => lists.filter((l) => l.id !== list.id))}
        />
      ))}
      <ActionButton
        variant="ghost"
        size="sm"
        onClick={() => draft.setLists((lists) => [...lists, newList(t("settings.corrections.newListName"))])}
      >
        {t("settings.corrections.addList")}
      </ActionButton>
      <SaveBar draft={draft} />
    </div>
  );
}
