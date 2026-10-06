import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { type Bundle, createI18n, I18nProvider } from "./i18n";
import en from "./locales/en/translation.json";
import { ToastProvider } from "./ui/Toast";
import { ConfirmProvider } from "./ui/ConfirmModal";
import { IsMobileContext } from "./hooks/media";

export const TEST_APP_VERSION = "0.0.0-test";

// Vite injects this at build time; the server renderer needs it defined.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = TEST_APP_VERSION;

// React 18's server renderer warns once per component that uses a layout
// effect. The pages are client-only, so the warning is expected noise here.
const originalConsoleError = console.error;
console.error = (message?: unknown, ...rest: unknown[]) => {
  if (typeof message === "string" && message.includes("useLayoutEffect does nothing on the server")) return;
  originalConsoleError(message, ...rest);
};

const i18nInstance = createI18n({ language: "en", fallback: "en", bundles: { en: en as Bundle } });

/** Seed value that puts a query into the error state instead of giving it data. */
export class SeededError {
  constructor(readonly message: string) {}
}

export type QuerySeed = ReadonlyArray<readonly [QueryKey, unknown]>;

export interface RenderedPage {
  html: string;
  /** Visible text with tags stripped and whitespace collapsed. */
  text: string;
  headings: string[];
  buttons: string[];
  links: string[];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&nbsp;": " ",
};

function toText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[#\w]+;/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

function innerTexts(html: string, pattern: RegExp): string[] {
  return Array.from(html.matchAll(pattern), (match) => toText(match[match.length - 1]));
}

/**
 * Server-renders a page with the providers the app mounts in main.tsx and
 * App.tsx. Seeded query data stands in for the API: effects never run in the
 * server renderer, so nothing is fetched.
 */
export interface RenderOptions {
  /** Render the phone layout, as App does below the md breakpoint. */
  isMobile?: boolean;
}

export function renderPage(
  page: ReactElement,
  seed: QuerySeed = [],
  { isMobile = false }: RenderOptions = {},
): RenderedPage {
  // retryOnMount: false keeps a seeded error from being reported optimistically
  // as "pending" (the observer would otherwise plan a refetch on mount).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  for (const [key, data] of seed) {
    if (data instanceof SeededError) {
      const error = new Error(data.message);
      queryClient
        .getQueryCache()
        .build(queryClient, { queryKey: key })
        .setState({ status: "error", error, fetchStatus: "idle", errorUpdateCount: 1 });
    } else {
      queryClient.setQueryData(key, data);
    }
  }
  const html = renderToString(
    <I18nProvider i18n={i18nInstance}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <IsMobileContext.Provider value={isMobile}>
            <ToastProvider>
              <ConfirmProvider>{page}</ConfirmProvider>
            </ToastProvider>
          </IsMobileContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return {
    html,
    text: toText(html),
    headings: innerTexts(html, /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g),
    buttons: innerTexts(html, /<button\b[^>]*>([\s\S]*?)<\/button>/g),
    links: innerTexts(html, /<a\b[^>]*>([\s\S]*?)<\/a>/g),
  };
}
