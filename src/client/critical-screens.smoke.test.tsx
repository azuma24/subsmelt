/**
 * Smoke render tests for critical screens.
 * Uses react-dom/server (already a dependency) + node:test — matching the
 * existing suite. No Testing Library / jsdom dependency.
 */
import test from "node:test";
import assert from "node:assert/strict";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "./locales/en/translation.json";
import { ToastProvider } from "./components/Toast";
import { ConfirmProvider } from "./components/ConfirmModal";
import { DashboardPage } from "./features/dashboard";
import { SettingsPage } from "./features/settings/SettingsPage";
import { WhisperPage } from "./features/whisper/WhisperPage";
import { ConvertPage } from "./features/convert/ConvertPage";
import { JobDetailPage } from "./features/jobs/JobDetailPage";

function installDomShims() {
  const g = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
    document?: Document;
    localStorage?: Storage;
    EventSource?: typeof EventSource;
    matchMedia?: typeof window.matchMedia;
  };

  if (!g.localStorage) {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k)! : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
      key: () => null,
      get length() { return store.size; },
    } as Storage;
  }

  if (typeof g.window === "undefined") {
    g.window = g as unknown as Window & typeof globalThis;
  }
  if (typeof g.document === "undefined") {
    g.document = {
      documentElement: { dir: "ltr", lang: "en" },
      getElementById: () => null,
    } as unknown as Document;
  }
  if (typeof g.matchMedia !== "function") {
    g.matchMedia = (() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    (g.window as Window).matchMedia = g.matchMedia;
  }
  if (typeof g.EventSource === "undefined") {
    g.EventSource = class {
      url: string;
      onerror: ((ev: Event) => void) | null = null;
      constructor(url: string) { this.url = url; }
      addEventListener() {}
      close() {}
    } as unknown as typeof EventSource;
  }

  // Quiet network calls during smoke render — queries stay in loading state.
  g.fetch = (async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

async function ensureI18n() {
  if (i18n.isInitialized) return;
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en as Record<string, unknown> } },
    interpolation: { escapeValue: false },
  });
}

function Providers({ children, initialPath = "/" }: { children: ReactNode; initialPath?: string }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

function renderScreen(node: ReactNode, initialPath = "/") {
  return renderToStaticMarkup(<Providers initialPath={initialPath}>{node}</Providers>);
}

installDomShims();

test("smoke: DashboardPage renders without throwing", async () => {
  await ensureI18n();
  const html = renderScreen(<DashboardPage isMobile={false} />);
  assert.match(html, /Dashboard|queue|Scan|Run/i);
});

test("smoke: SettingsPage renders without throwing", async () => {
  await ensureI18n();
  const html = renderScreen(<SettingsPage isMobile={false} />, "/settings");
  assert.match(html, /Settings|LLM|Speech|Engine/i);
});

test("smoke: WhisperPage (Transcribe) renders without throwing", async () => {
  await ensureI18n();
  const html = renderScreen(<WhisperPage isMobile={false} />, "/whisper");
  assert.match(html, /Transcribe|Whisper|Library|Settings/i);
});

test("smoke: ConvertPage renders without throwing", async () => {
  await ensureI18n();
  const html = renderScreen(<ConvertPage isMobile={false} />, "/convert");
  assert.match(html, /Convert|Translate|Drop|format/i);
});

test("smoke: JobDetailPage renders queue-not-found without throwing", async () => {
  await ensureI18n();
  const html = renderScreen(
    <Routes>
      <Route path="/jobs/:id" element={<JobDetailPage />} />
    </Routes>,
    "/jobs/1",
  );
  // While jobs query is empty/loading, the page shows loading or not-found.
  assert.ok(html.length > 0);
  assert.match(html, /Loading|not found|Job|job/i);
});
