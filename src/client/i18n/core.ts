/**
 * The translation runtime: a language, its bundles (nested JSON of strings),
 * and `t`. Keys are dotted paths; `{{name}}` interpolates; a `count` option
 * picks the plural form by the language's CLDR category (`key_one`,
 * `key_few`, `key_other`, ...), with `key_zero` for a count of zero when a
 * bundle has it. A key missing from the language falls back to the language's
 * base ("pt-BR" to "pt") and then to the fallback language; a key missing
 * everywhere comes back as the key itself, so a typo is visible, not blank.
 */

export type Bundle = { [key: string]: string | Bundle };

export interface TranslateOptions {
  count?: number;
  defaultValue?: string;
  [placeholder: string]: unknown;
}

/** `t(key)`, `t(key, { count, ...placeholders })`, `t(key, "default text")`, or `t([key, fallbackKey])` for the first key that exists. */
export type TFunction = (key: string | string[], options?: TranslateOptions | string) => string;

export type I18nEvent = "languageChanged" | "loaded";

export interface I18n {
  /** The language in use, as a BCP 47 tag ("en", "zh-TW"). */
  readonly language: string;
  readonly t: TFunction;
  /** Switches the language, loading its bundle first when a loader is set. Resolves once the UI can use it. */
  changeLanguage(language: string): Promise<void>;
  hasBundle(language: string): boolean;
  addBundle(language: string, bundle: Bundle): void;
  /** Subscribes to a language change or a bundle arriving; returns the unsubscribe. */
  on(event: I18nEvent, listener: () => void): () => void;
}

export interface I18nOptions {
  language: string;
  fallback: string;
  bundles?: Record<string, Bundle>;
  /** Fetches a language's bundle on demand; null means the language has none. */
  load?: (language: string) => Promise<Bundle | null>;
}

const INTERPOLATION = /\{\{\s*([^}\s]+)\s*\}\}/g;

function lookup(bundle: Bundle | undefined, key: string): string | undefined {
  let node: string | Bundle | undefined = bundle;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

const pluralRules = new Map<string, Intl.PluralRules>();

function pluralCategory(language: string, count: number): string {
  let rules = pluralRules.get(language);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(language);
    } catch {
      rules = new Intl.PluralRules("en");
    }
    pluralRules.set(language, rules);
  }
  return rules.select(count);
}

/** The languages a key is looked up in, most specific first: the language, its base, the fallback. */
function chain(language: string, fallback: string): string[] {
  const base = language.split("-")[0];
  return [...new Set([language, base, fallback])];
}

export function interpolate(template: string, options: TranslateOptions | undefined): string {
  if (!options) return template;
  return template.replace(INTERPOLATION, (match, name: string) => {
    const value = options[name];
    return value === undefined || value === null ? match : String(value);
  });
}

export function createI18n(options: I18nOptions): I18n {
  const bundles = new Map<string, Bundle>(Object.entries(options.bundles ?? {}));
  const listeners: Record<I18nEvent, Set<() => void>> = { languageChanged: new Set(), loaded: new Set() };
  const loading = new Map<string, Promise<void>>();
  let language = options.language;

  const emit = (event: I18nEvent) => {
    for (const listener of listeners[event]) listener();
  };

  const resolve = (key: string, opts: TranslateOptions | undefined): string | undefined => {
    const keys: string[] = [];
    if (opts?.count !== undefined) {
      keys.push(`${key}_${pluralCategory(language, opts.count)}`);
      if (opts.count === 0) keys.unshift(`${key}_zero`);
    }
    keys.push(key);
    for (const lng of chain(language, options.fallback)) {
      const bundle = bundles.get(lng);
      if (!bundle) continue;
      for (const candidate of keys) {
        const found = lookup(bundle, candidate);
        if (found !== undefined) return interpolate(found, opts);
      }
    }
    return undefined;
  };

  const translate: TFunction = (key, options) => {
    const opts = typeof options === "string" ? { defaultValue: options } : options;
    const keys = Array.isArray(key) ? key : [key];
    for (const candidate of keys) {
      const found = resolve(candidate, opts);
      if (found !== undefined) return found;
    }
    if (opts?.defaultValue !== undefined) return interpolate(opts.defaultValue, opts);
    return keys[keys.length - 1] ?? "";
  };

  const load = (lng: string): Promise<void> => {
    if (!options.load || bundles.has(lng) || lng === options.fallback) return Promise.resolve();
    const pending = loading.get(lng);
    if (pending) return pending;
    const request = options
      .load(lng)
      .then((bundle) => {
        if (bundle) {
          bundles.set(lng, bundle);
          emit("loaded");
        }
      })
      .catch(() => undefined)
      .finally(() => loading.delete(lng));
    loading.set(lng, request);
    return request;
  };

  const i18n: I18n = {
    get language() {
      return language;
    },
    t: translate,
    async changeLanguage(next) {
      await load(next);
      if (next === language) return;
      language = next;
      emit("languageChanged");
    },
    hasBundle: (lng) => bundles.has(lng),
    addBundle(lng, bundle) {
      bundles.set(lng, bundle);
      emit("loaded");
    },
    on(event, listener) {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  };
  void load(language);
  return i18n;
}
