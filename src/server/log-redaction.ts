import { SECRET_SETTING_KEYS } from "../shared/settings.js";

const REDACTED = "[redacted]";
const SECRET_FIELDS = new Set([
  ...SECRET_SETTING_KEYS,
  "apikey",
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-subsmelt-token",
  "access_token",
]);

const INLINE_CREDENTIAL =
  /(?<![\w.-])((?:(?:proxy-)?authorization|x-(?:api-key|subsmelt-token)|api[_-]?key|access_token)["']?[ \t]*[:=][ \t]*["']?(?:(?:Bearer|Basic)[ \t]+)?)([^\s"'`,;}\]]+)/gi;
const URL_CREDENTIAL = /([?&](?:api[_-]?key|access_token)=)[^&#\s"']+|(https?:\/\/)[^/?#\s@]+@/gi;

let secretSource: () => readonly string[] = () => [];
let previousSecrets: readonly string[] | undefined;
let configuredCredentials: (string | RegExp)[] = [];

export function setLogSecretSource(source: () => readonly string[]): void {
  secretSource = source;
  previousSecrets = undefined;
}

function compileCredentials(secrets: readonly string[]): (string | RegExp)[] {
  const variants = new Set<string>();
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (!trimmed) continue;
    variants.add(secret);
    variants.add(trimmed);
    variants.add(JSON.stringify(trimmed).slice(1, -1));
    try {
      variants.add(encodeURIComponent(trimmed));
    } catch {
      // Legacy config can contain a lone UTF-16 surrogate. Its raw and JSON forms still redact.
    }
  }
  return [...variants]
    .sort((left, right) => right.length - left.length)
    .map((value) => {
      if (value.length >= 4) return value;
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Very short keys should match standalone values without mangling every word containing them.
      return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "g");
    });
}

export function logTextRedactor(): (message: string) => string {
  const secrets = secretSource();
  if (secrets !== previousSecrets) {
    configuredCredentials = compileCredentials(secrets);
    previousSecrets = secrets;
  }
  const credentials = configuredCredentials;
  return (message) => {
    let sanitized = message;
    for (const credential of credentials) sanitized = sanitized.replaceAll(credential, REDACTED);
    return sanitized
      .replace(URL_CREDENTIAL, (_match, query: string | undefined, scheme: string | undefined) =>
        query ? `${query}${REDACTED}` : `${scheme}${REDACTED}@`,
      )
      .replace(INLINE_CREDENTIAL, (match, prefix: string, value: string) =>
        value === "[redacted" ? match : `${prefix}${REDACTED}`,
      );
  };
}

export function redactLogMeta(
  meta: Record<string, unknown>,
  redactText: (text: string) => string,
): Record<string, unknown> {
  // Keep JSON serialization behavior for arrays, Dates and custom metadata values.
  return JSON.parse(
    JSON.stringify(meta, (key, value: unknown) => {
      if (SECRET_FIELDS.has(key.toLowerCase()) && value != null && value !== "") return REDACTED;
      return typeof value === "string" ? redactText(value) : value;
    }),
  );
}
