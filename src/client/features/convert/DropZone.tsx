import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACCEPT_ATTR } from "./download-outputs";

interface DropZoneProps {
  onFiles: (files: FileList | File[]) => void;
}

/** Drop zone + hidden file input for staging subtitle files. */
export function DropZone({ onFiles }: DropZoneProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("convert.browse")}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
        isDragging
          ? "border-[var(--accent)] bg-[var(--accent-dim)]"
          : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent-border)]"
      }`}
    >
      <span className="text-3xl" aria-hidden="true">📂</span>
      <p className="text-[13px] font-medium text-[var(--text)]">{t("convert.dropzone")}</p>
      <p className="text-[11.5px] text-[var(--text-3)]">{t("convert.dropzoneHint")}</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
