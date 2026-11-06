import { useState } from "react";
import { previewTranscriptionReview, type ReviewOperation } from "../../api";
import { useTranslation } from "../../i18n";
import { getErrorMessage } from "../../lib";
import { TextArea } from "../../ui/Field";
import { ActionButton, Field, Select } from "../../ui/primitives";
import { SubtitleQualityReport } from "../../ui/SubtitleQualityReport";

type Preview = Awaited<ReturnType<typeof previewTranscriptionReview>>;

export function ReviewTransforms({
  id,
  revision,
  content,
  onApply,
}: {
  id: string;
  revision: string;
  content?: string;
  onApply: (preview: Preview) => void;
}) {
  const { t } = useTranslation();
  const [operations, setOperations] = useState<ReviewOperation[]>([]);
  const [kind, setKind] = useState<ReviewOperation["kind"]>("offset");
  const [offset, setOffset] = useState("0");
  const [from, setFrom] = useState("25");
  const [to, setTo] = useState("24");
  const [width, setWidth] = useState("42");
  const [result, setResult] = useState<{ base?: string; preview: Preview }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const add = () => {
    const operation: ReviewOperation =
      kind === "offset"
        ? { kind, milliseconds: Number(offset) }
        : kind === "frameRate"
          ? { kind, from: Number(from), to: Number(to) }
          : { kind, width: Number(width) };
    setOperations([...operations, operation]);
    setResult(undefined);
  };
  const preview = async () => {
    setError("");
    setBusy(true);
    try {
      setResult({ base: content, preview: await previewTranscriptionReview(id, { revision, content, operations }) });
    } catch (e) {
      setResult(undefined);
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const label = (operation: ReviewOperation) =>
    operation.kind === "offset"
      ? t("processing.offsetSummary", { milliseconds: operation.milliseconds })
      : operation.kind === "frameRate"
        ? t("processing.frameRateSummary", { from: operation.from, to: operation.to })
        : t("processing.balanceSummary", { width: operation.width });
  return (
    <details className="space-y-2 rounded border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm text-text">{t("processing.transforms")}</summary>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          ariaLabel={t("processing.transformType")}
          value={kind}
          onChange={(value) => setKind(value as ReviewOperation["kind"])}
        >
          <option value="offset">{t("processing.offset")}</option>
          <option value="frameRate">{t("processing.frameRate")}</option>
          <option value="balance">{t("processing.balance")}</option>
        </Select>
        {kind === "offset" && (
          <Field label={t("processing.offset")} type="number" value={offset} onChange={setOffset} />
        )}
        {kind === "frameRate" && (
          <>
            <Field label={t("processing.fromFps")} type="number" value={from} onChange={setFrom} />
            <Field label={t("processing.toFps")} type="number" value={to} onChange={setTo} />
          </>
        )}
        {kind === "balance" && (
          <Field label={t("processing.maxWidth")} type="number" value={width} onChange={setWidth} />
        )}
        <ActionButton size="sm" variant="ghost" disabled={busy || operations.length >= 20} onClick={add}>
          {t("processing.addTransform")}
        </ActionButton>
      </div>
      {operations.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          {operations.map((operation, index) => (
            <li key={index}>
              {label(operation)}
              <ActionButton
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setOperations(operations.filter((_, position) => position !== index));
                  setResult(undefined);
                }}
              >
                {t("common.delete")}
              </ActionButton>
            </li>
          ))}
        </ol>
      )}
      <ActionButton size="sm" variant="ghost" disabled={busy || !operations.length} onClick={() => void preview()}>
        {t("processing.previewTransforms")}
      </ActionButton>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {result && result.base === content && (
        <div className="space-y-2">
          <TextArea
            label={t("processing.previewTransforms")}
            value={result.preview.content}
            onChange={() => {}}
            rows={8}
            readOnly
            mono
          />
          <SubtitleQualityReport issues={result.preview.issues} label={t("processing.sourceQuality")} />
          <ActionButton
            size="sm"
            onClick={() => {
              onApply(result.preview);
              setResult(undefined);
              setOperations([]);
            }}
          >
            {t("processing.usePreview")}
          </ActionButton>
        </div>
      )}
    </details>
  );
}
