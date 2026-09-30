import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../../api";
import { useConfirm } from "../../components/ConfirmModal";
import { useToast } from "../../components/Toast";
import { getErrorMessage } from "../../lib";
import type { YoutubePlaylist } from "../../types";

/** Check now and Unfollow, shared by the playlist list and the playlist page. */
export function usePlaylistActions() {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState<Set<string>>(new Set());

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["youtube"] });

  const checkNow = async (playlist: YoutubePlaylist) => {
    setChecking((prev) => new Set(prev).add(playlist.id));
    try {
      const result = await api.syncYoutubePlaylist(playlist.id);
      addToast(t("youtube.toast.checked", { title: result.title, added: result.added, removed: result.removed }), "success");
    } catch (error) {
      addToast(t("youtube.toast.checkFailed", { error: getErrorMessage(error) }), "error");
    } finally {
      setChecking((prev) => {
        const next = new Set(prev);
        next.delete(playlist.id);
        return next;
      });
      void refresh();
    }
  };

  const unfollow = async (playlist: YoutubePlaylist): Promise<boolean> => {
    const ok = await confirm({
      title: t("youtube.unfollowConfirm.title", { title: playlist.title }),
      message: t("youtube.unfollowConfirm.message"),
      confirmLabel: t("youtube.unfollowConfirm.confirm"),
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.unfollowYoutubePlaylist(playlist.id);
      addToast(t("youtube.toast.unfollowed", { title: playlist.title }), "success");
      await refresh();
      return true;
    } catch (error) {
      addToast(getErrorMessage(error), "error");
      return false;
    }
  };

  const isChecking = (playlist: YoutubePlaylist) => checking.has(playlist.id) || playlist.sync.checking;

  return { checkNow, unfollow, isChecking };
}
