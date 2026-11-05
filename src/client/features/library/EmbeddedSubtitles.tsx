import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EmbeddedSubtitleImport, EmbeddedSubtitleProbe } from "../../../shared/embedded-subtitles";
import { ApiError, fetchJSON } from "../../api";
import { useMutationWithInvalidation } from "../../hooks";
import { useTranslation } from "../../i18n";
import { ActionButton } from "../../ui/primitives";
import { InlineError } from "../../ui/QueryState";

const API_PATH = "/library/embedded-subtitles";

function languageName(names: Intl.DisplayNames, tag: string): string {
  try {
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function EmbeddedSubtitles({ videoPath }: { videoPath: string }) {
  const { t, i18n } = useTranslation();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<{ index: number; revision: string } | null>(null);
  const probe = useQuery({
    queryKey: ["embedded-subtitles", videoPath],
    queryFn: ({ signal }) =>
      fetchJSON<EmbeddedSubtitleProbe>(`${API_PATH}?${new URLSearchParams({ videoPath })}`, { signal }),
    enabled: expanded,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const importTrack = useMutationWithInvalidation((selection: NonNullable<typeof selected>) =>
    fetchJSON<EmbeddedSubtitleImport>(API_PATH, {
      method: "POST",
      body: JSON.stringify({ videoPath, ...selection }),
    }),
  );
  const tracks = probe.data?.tracks ?? [];
  const canImport = tracks.some((track) => track.format);
  const active = selected?.revision === probe.data?.revision ? selected : null;
  const languages = new Intl.DisplayNames([i18n.language], { type: "language" });
  const importError = importTrack.error instanceof ApiError ? importTrack.error : null;
  const changed = importError?.status === 412;
  const refresh = () => {
    setSelected(null);
    importTrack.reset();
    void probe.refetch();
  };

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={listId}
        className="inline-flex min-h-touch items-center justify-center rounded-sm border border-border bg-surface px-3 text-sm font-medium text-text transition-colors duration-fast hover:bg-surface-raised"
      >
        {t("library.embedded.find")}
      </button>
      <div id={listId} hidden={!expanded} className="space-y-3">
        {expanded && (
          <>
            {probe.isPending && (
              <p role="status" className="text-sm text-muted">
                {t("library.embedded.loading")}
              </p>
            )}
            {probe.isError && <InlineError message={probe.error.message} onRetry={refresh} />}
            {probe.data && !probe.isError && (
              <>
                {tracks.length === 0 ? (
                  <p role="status" className="text-sm text-muted">
                    {t("library.embedded.none")}
                  </p>
                ) : (
                  <fieldset disabled={importTrack.isPending}>
                    <legend className="mb-2 text-sm font-medium text-text">
                      {t(canImport ? "library.embedded.choose" : "library.embedded.noText")}
                    </legend>
                    <ul className="divide-y divide-border rounded-md border border-border">
                      {tracks.map((track, position) => {
                        const label = [
                          t("library.embedded.track", { number: position + 1 }),
                          track.language
                            ? languageName(languages, track.language)
                            : t("library.embedded.unknownLanguage"),
                          track.codec,
                          track.isDefault && t("library.embedded.default"),
                          track.isForced && t("library.embedded.forced"),
                          !track.format &&
                            t(track.isBitmap ? "library.embedded.bitmap" : "library.embedded.unsupported"),
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <li
                            key={track.index}
                            className={active?.index === track.index ? "bg-accent-soft" : undefined}
                          >
                            <label
                              className={`flex min-h-touch items-center gap-3 px-3 py-2 ${track.format ? "cursor-pointer hover:bg-surface-raised" : "text-muted"}`}
                            >
                              <input
                                type="radio"
                                name={listId}
                                checked={active?.index === track.index}
                                disabled={!track.format}
                                onChange={() => {
                                  if (!probe.data) return;
                                  setSelected({ index: track.index, revision: probe.data.revision });
                                  importTrack.reset();
                                }}
                                className="shrink-0 accent-accent"
                              />
                              <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                                <span>{label}</span>
                                {track.title && <bdi className="block text-xs text-muted">{track.title}</bdi>}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                )}
                {canImport && (
                  <ActionButton
                    variant="ghost"
                    size="sm"
                    disabled={!active || changed}
                    busy={importTrack.isPending}
                    onClick={() => active && importTrack.mutate(active, { onSuccess: () => setSelected(null) })}
                  >
                    {t(importTrack.isPending ? "library.embedded.importing" : "library.embedded.import")}
                  </ActionButton>
                )}
              </>
            )}
            {importTrack.isError && (
              <InlineError
                message={
                  changed
                    ? t("library.embedded.changed")
                    : importError?.status === 409
                      ? t("library.embedded.conflict")
                      : (importError?.message ?? t("library.embedded.failed"))
                }
                onRetry={changed ? refresh : undefined}
              />
            )}
            <div role="status" className="text-sm text-success">
              {importTrack.data && t("library.embedded.imported", { file: importTrack.data.file })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
