import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "../../api";
import { useTranslation } from "../../i18n";
import { ActionButton, Select } from "../../ui/primitives";

interface Track {
  index: number;
  codec: string;
  language: string;
  title: string;
  isDefault: boolean;
}

export function AudioTrackPicker({
  input,
  track,
  onChange,
}: {
  input: string;
  track?: number;
  onChange: (track?: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["audio-tracks", input],
    queryFn: ({ signal }) =>
      fetchJSON<{ tracks: Track[] }>(`/transcribe/audio-tracks?${new URLSearchParams({ input })}`, { signal }),
    enabled: open,
    retry: false,
  });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
      {!open && (
        <ActionButton size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {t("processing.chooseAudio")}
        </ActionButton>
      )}
      {open && query.isPending && <span role="status">{t("errors.loading")}</span>}
      {open && query.isError && (
        <span role="alert" className="text-danger">
          {t("processing.audioProbeFailed")}
        </span>
      )}
      {open && query.data && (
        <Select
          ariaLabel={t("processing.chooseAudio")}
          value={track === undefined ? "" : String(track)}
          onChange={(value) => onChange(value ? Number(value) : undefined)}
        >
          <option value="">{t("processing.defaultAudio")}</option>
          {query.data.tracks.map(({ index, codec, language, title, isDefault }) => (
            <option key={index} value={index}>
              {[
                t("library.embedded.track", { number: index }),
                language,
                title,
                codec,
                isDefault && t("library.embedded.default"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
