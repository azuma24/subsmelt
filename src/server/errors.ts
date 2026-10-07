/**
 * Reading a thrown value. TypeScript types a catch variable as unknown, which
 * is right: the AI SDK, fetch, better-sqlite3 and plain strings all end up
 * here. These helpers read the fields the app cares about without a cast at
 * every site.
 */

type ErrorLike = {
  message?: unknown;
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown } | null;
  cause?: unknown;
};

const asErrorLike = (error: unknown): ErrorLike | null =>
  error !== null && typeof error === "object" ? (error as ErrorLike) : null;

/** The message of an Error, a thrown string as it is, or String() of anything else. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const message = asErrorLike(error)?.message;
  return typeof message === "string" ? message : String(error);
}

/** An Error's name (AbortError, TypeError), when there is one. */
export function errorName(error: unknown): string | undefined {
  const name = asErrorLike(error)?.name;
  return typeof name === "string" ? name : undefined;
}

/** The class of a thrown value, for diagnostics: "APICallError", "string", "null". */
export function errorClassName(error: unknown): string {
  if (error === null) return "null";
  if (typeof error !== "object") return typeof error;
  return error.constructor?.name ?? "object";
}

/** An HTTP status an SDK error carries, under any of the names the SDKs use. */
export function errorStatus(error: unknown): number | undefined {
  const err = asErrorLike(error);
  for (const value of [err?.status, err?.statusCode, err?.response?.status]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** The message of an Error's cause, when it has one with a message. */
export function errorCauseMessage(error: unknown): string | undefined {
  const cause = asErrorLike(error)?.cause;
  const message = asErrorLike(cause)?.message;
  return typeof message === "string" ? message : undefined;
}
