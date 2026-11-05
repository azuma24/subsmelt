import type { TFunction } from "../../i18n";
import type { ScanResult } from "../../types";

export function scanPartialMessage(t: TFunction, errors: unknown): string {
  const first = Array.isArray(errors) ? errors[0] : undefined;
  return first && typeof first.path === "string" && typeof first.message === "string"
    ? `${t("dashboard.scanPartial")} ${first.path}: ${first.message}`
    : t("dashboard.scanPartial");
}

/** Render paths and OS errors as text, never HTML. */
export function ScanWarning({ errors, t }: { errors: ScanResult["errors"]; t: TFunction }) {
  return (
    <div role="alert" className="border border-danger-line bg-surface px-4 py-3 text-sm text-danger">
      <p>{t("dashboard.scanPartial")}</p>
      {errors.length > 0 && (
        <ul className="mt-1 list-inside list-disc break-words">
          {errors.map((error, index) => (
            <li key={`${error.path}-${index}`}>
              {error.path}: {error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
