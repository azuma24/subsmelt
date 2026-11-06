import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  approveTranscriptionReview,
  cancelTranscriptionWork,
  getTranscriptionReview,
  transcriptionWorkDownloadUrl,
  type TranscriptionWork,
} from "../../api";
import { useTranslation } from "../../i18n";
import { getErrorMessage } from "../../lib";
import { TextArea } from "../../ui/Field";
import { ActionButton } from "../../ui/primitives";
import { SubtitleQualityReport } from "../../ui/SubtitleQualityReport";
import { ReviewTransforms } from "./ReviewTransforms";
import { formatBytes } from "../convert/download-outputs";
import { transcriptionReviewAnchor } from "../dashboard/transcription-progress";

function SourceReview({ item, onChange }: { item: TranscriptionWork; onChange: () => void }) {
  const { t } = useTranslation();
  const review = useQuery({
    queryKey: ["transcription-review", item.id, item.updatedAt],
    queryFn: ({ signal }) => getTranscriptionReview(item.id, { signal }),
    retry: false,
  });
  const [edited, setEdited] = useState<string>();
  const [selected, setSelected] = useState(() => new Set((item.plan?.targets ?? []).map(({ id }) => id)));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const commit = async (approve: boolean) => {
    setError("");
    setBusy(true);
    try {
      if (approve && review.data) {
        await approveTranscriptionReview(item.id, {
          revision: review.data.revision,
          content: edited,
          targetIds: [...selected],
        });
      } else {
        await cancelTranscriptionWork(item.id);
      }
      onChange();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      {review.isPending && (
        <p role="status" className="text-sm text-muted">
          {t("errors.loading")}
        </p>
      )}
      {review.isError && (
        <p role="alert" className="text-sm text-danger">
          {getErrorMessage(review.error)}
        </p>
      )}
      {review.data && (
        <>
          <TextArea
            label={t("processing.sourceTranscript")}
            value={edited ?? review.data.content}
            onChange={setEdited}
            rows={10}
            mono
            readOnly={busy}
          />
          <SubtitleQualityReport issues={review.data.issues} label={t("processing.sourceQuality")} />
          <ReviewTransforms
            id={item.id}
            revision={review.data.revision}
            content={edited}
            onApply={({ content }) => setEdited(content)}
          />
          {!!item.plan?.targets?.length && (
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm" disabled={busy}>
              <legend className="mb-1 font-medium">{t("processing.targets")}</legend>
              {item.plan.targets.map(({ id, label }) => (
                <label key={id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={selected.has(id)}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      {(error || item.error) && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-danger">
            {error || item.error}
          </p>
          <ActionButton
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void review.refetch().then((result) => {
                if (result.isSuccess) {
                  setEdited(undefined);
                  setError("");
                }
              });
            }}
          >
            {t("processing.reloadTranscript")}
          </ActionButton>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <ActionButton size="sm" disabled={busy || !review.data} onClick={() => void commit(true)}>
          {t("processing.approve")}
        </ActionButton>
        <ActionButton size="sm" variant="ghost" disabled={busy} onClick={() => void commit(false)}>
          {t("processing.cancelReview")}
        </ActionButton>
        {review.data && (
          <a href={transcriptionWorkDownloadUrl(item.id)} className="self-center text-sm text-accent underline">
            {t("processing.downloadTranscript")}
          </a>
        )}
      </div>
    </div>
  );
}

export function TranscriptionProcessingPanel({ work, onChange }: { work: TranscriptionWork[]; onChange: () => void }) {
  const { t } = useTranslation();
  const pending = work.filter((item) => item.status === "needs_review");
  const location = useLocation();
  const anchor = location.hash.slice(1);
  const hasReviewAnchor =
    pending.some(({ id }) => anchor === transcriptionReviewAnchor(id)) ||
    (pending.length > 0 && anchor === transcriptionReviewAnchor());

  useEffect(() => {
    if (!hasReviewAnchor) return;
    const target = document.getElementById(location.hash.slice(1));
    const details = target?.closest("details");
    if (details) details.open = true;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "start" });
  }, [location, hasReviewAnchor]);
  const recent = work
    .filter(
      (item) =>
        item.status !== "needs_review" &&
        (item.plan?.profile ||
          item.noteReady ||
          Object.keys(item.timingsMs ?? {}).length ||
          item.translationIssues?.length),
    )
    .slice(-10)
    .reverse();
  const items = [...pending, ...recent];
  if (!items.length) return null;

  return (
    <section className="space-y-2 rounded-md border border-border bg-surface-raised p-3">
      <h2 id={transcriptionReviewAnchor()} tabIndex={-1} className="scroll-mt-3 text-sm font-semibold text-text">
        {t("processing.recentWork")}
      </h2>
      {items.map((item) => {
        const input = item.input.split(/[/\\]/).filter(Boolean).at(-1) ?? item.input;
        const effective = item.plan?.effective;
        return (
          <details
            key={item.id}
            open={item.status === "needs_review" || undefined}
            className="space-y-2 rounded border border-border px-3 py-2"
          >
            <summary
              id={item.status === "needs_review" ? transcriptionReviewAnchor(item.id) : undefined}
              className="scroll-mt-3 cursor-pointer break-words text-sm font-medium text-text"
              title={item.input}
            >
              {input}
              {item.status === "needs_review" && (
                <span className="ml-2 text-warning">{t("processing.pendingReview")}</span>
              )}
            </summary>
            {effective && (
              <p className="break-words text-xs text-muted">
                {[
                  item.plan?.profile?.name,
                  effective.model,
                  effective.language,
                  effective.output_format.toUpperCase(),
                  effective.device,
                  effective.compute_type,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            {item.status === "failed" && item.error && (
              <p role="alert" className="text-sm text-danger">
                {item.error}
              </p>
            )}
            {item.status === "needs_review" && <SourceReview key={item.updatedAt} item={item} onChange={onChange} />}
            {item.noteReady && (
              <a href={transcriptionWorkDownloadUrl(item.id, true)} className="block text-sm text-accent underline">
                {t("processing.downloadNote")}
              </a>
            )}
            {!!item.translationIssues?.length && (
              <ul className="space-y-1 text-xs text-warning">
                {item.translationIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {item.uploadedBytes !== undefined && (
              <p className="text-xs text-muted">
                {t(item.audioOnlyUploaded ? "processing.audioUploadSummary" : "processing.uploadSummary", {
                  size: formatBytes(item.uploadedBytes),
                })}
              </p>
            )}
            {item.checkpointHit && <p className="text-xs text-muted">{t("processing.checkpointHit")}</p>}
            {!!Object.keys(item.timingsMs ?? {}).length && (
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {Object.entries(item.timingsMs ?? {}).map(([phase, elapsed]) => (
                  <div className="flex items-baseline gap-1" key={phase}>
                    <dt>{t(`processing.phases.${phase}`)}</dt>
                    <dd className="font-mono tabular-nums">{t("processing.milliseconds", { elapsed })}</dd>
                  </div>
                ))}
              </dl>
            )}
          </details>
        );
      })}
    </section>
  );
}
