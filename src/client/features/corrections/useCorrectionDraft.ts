import { useEffect, useMemo, useState } from "react";
import {
  correctionRuleSetsIssues,
  parseCorrectionRuleSets,
  type CorrectionIssue,
  type CorrectionRuleSet,
} from "../../../shared/corrections";

export interface CorrectionDraft {
  lists: CorrectionRuleSet[];
  setLists: (update: (lists: CorrectionRuleSet[]) => CorrectionRuleSet[]) => void;
  dirty: boolean;
  /** Why the draft cannot be saved; empty when it can. */
  errors: CorrectionIssue[];
  saving: boolean;
  save: () => Promise<void>;
  discard: () => void;
}

/**
 * A local, validated draft of the `correction_rule_sets` setting. Edits stay
 * here until saved: the server refuses a whole settings request over one
 * invalid rule, so a half-typed rule must never be sent. While nothing is
 * being edited the draft follows the saved value (it arrives after the first
 * render, and changes when the other editor saves).
 */
export function useCorrectionDraft(saved: string, persist: (json: string) => unknown): CorrectionDraft {
  const [lists, setListsState] = useState<CorrectionRuleSet[]>(() => parseCorrectionRuleSets(saved));
  const [baseline, setBaseline] = useState(saved);
  const [saving, setSaving] = useState(false);

  const serialized = JSON.stringify(lists);
  const dirty = serialized !== JSON.stringify(parseCorrectionRuleSets(baseline));

  useEffect(() => {
    if (saved === baseline) return;
    if (!dirty) setListsState(parseCorrectionRuleSets(saved));
    setBaseline(saved);
  }, [saved, baseline, dirty]);

  const errors = useMemo(() => correctionRuleSetsIssues(serialized), [serialized]);

  return {
    lists,
    setLists: (update) => setListsState((current) => update(current)),
    dirty,
    errors,
    saving,
    save: async () => {
      if (errors.length || !dirty) return;
      setSaving(true);
      try {
        // No baseline update here: the saved value comes back through `saved`
        // (at once from the Settings form, after a refetch elsewhere), and a
        // failed save must leave the draft looking unsaved.
        await persist(serialized);
      } catch {
        // Reported by whoever saved (a toast); the draft stays unsaved so nothing is lost.
      } finally {
        setSaving(false);
      }
    },
    discard: () => setListsState(parseCorrectionRuleSets(baseline)),
  };
}
