import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "../../i18n";
import { useYoutubeNoteQuery, useYoutubeNotesQuery } from "../../hooks";
import { InlineError } from "../../ui/QueryState";
import { FORM_CONTROL_CLS } from "../../ui/form-classes";
import type { YoutubeNote, YoutubeNotesResponse } from "../../api";
import type { YoutubePlaylist } from "../../types";
import { Banner } from "./parts";
import { readableNoteMarkdown } from "./notes-reader";

const PAGE_SIZE = 30;
type NoteState = "all" | "saved" | "blocked";

export function NotesHealth({ health }: { health: YoutubeNotesResponse["health"] | undefined }) {
  const { t } = useTranslation();
  if (!health || (health.exists && health.writable && !health.blocked)) return null;
  return (
    <Banner tone="bad" title={t("youtube.notes.healthTitle")}>
      {t("youtube.notes.healthBody", { path: health.path })}
      <span className="mt-1 block text-xs">{t("youtube.notes.healthFix")}</span>
    </Banner>
  );
}

export function NotesPage({
  playlists,
  initialPlaylistId,
}: {
  playlists: YoutubePlaylist[];
  initialPlaylistId?: string;
}) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [playlistId, setPlaylistId] = useState(initialPlaylistId ?? "");
  const [state, setState] = useState<NoteState>("all");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
      setSelectedId(null);
      setReading(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useYoutubeNotesQuery({ query, playlistId, state, limit: PAGE_SIZE, offset });
  const detail = useYoutubeNoteQuery(selectedId);
  const notes = list.data?.notes ?? [];
  const selected = notes.find((n) => n.videoId === selectedId);
  const choose = (note: YoutubeNote) => {
    setSelectedId(note.videoId);
    setReading(true);
  };
  const changeState = (next: NoteState) => {
    setState(next);
    setOffset(0);
    setSelectedId(null);
    setReading(false);
  };
  const changePlaylist = (next: string) => {
    setPlaylistId(next);
    setOffset(0);
    setSelectedId(null);
    setReading(false);
  };
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">{t("youtube.notes.title")}</h1>
        <p className="text-sm text-muted">{t("youtube.notes.description")}</p>
      </div>
      <NotesHealth health={list.data?.health} />
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("youtube.notes.search")}
          aria-label={t("youtube.notes.search")}
          className={`${FORM_CONTROL_CLS} min-h-touch min-w-[180px] flex-1`}
        />
        <select
          value={playlistId}
          onChange={(e) => changePlaylist(e.target.value)}
          aria-label={t("youtube.notes.playlist")}
          className={`${FORM_CONTROL_CLS} min-h-touch max-w-full md:max-w-[220px]`}
        >
          <option value="">{t("youtube.notes.allPlaylists")}</option>
          {playlists.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <div className="flex gap-1 overflow-x-auto" role="group" aria-label={t("youtube.notes.filter")}>
          {(["all", "saved", "blocked"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => changeState(value)}
              aria-pressed={state === value}
              className={`min-h-touch shrink-0 rounded-sm border px-3 text-xs ${state === value ? "border-accent text-accent bg-accent-soft" : "border-border text-muted hover:text-text"}`}
            >
              {t(`youtube.notes.${value}`)}
            </button>
          ))}
        </div>
      </div>
      {list.isError ? (
        <InlineError onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <p role="status" className="p-4 text-sm text-muted">
          {t("youtube.notes.loading")}
        </p>
      ) : (
        <>
          <p className="text-xs text-faint">{t("youtube.notes.results", { count: list.data?.total ?? 0 })}</p>
          {notes.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted">
              {t("youtube.notes.empty")}
            </p>
          ) : (
            <div className="grid overflow-hidden rounded-md border border-border bg-surface md:min-h-[420px] md:grid-cols-[minmax(220px,320px)_minmax(0,1fr)]">
              <div
                className={`${reading ? "hidden md:block" : "block"} border-border md:max-h-[70vh] md:overflow-y-auto md:border-r`}
              >
                {notes.map((note) => (
                  <button
                    type="button"
                    key={note.videoId}
                    onClick={() => choose(note)}
                    aria-current={selectedId === note.videoId ? "true" : undefined}
                    className={`block w-full border-b border-border px-4 py-3 text-left hover:bg-surface-raised ${selectedId === note.videoId ? "bg-accent-soft" : ""}`}
                  >
                    <strong className="block break-words text-sm text-text">{note.title}</strong>
                    <span className="mt-1 block text-xs text-muted">
                      {note.playlistTitle} · {note.channel || "YouTube"}
                    </span>
                    <span
                      className={`mt-1 block text-xs ${note.status === "blocked" ? "text-danger" : "text-success"}`}
                    >
                      {t(`youtube.notes.${note.status}`)}
                    </span>
                  </button>
                ))}
              </div>
              <div className={`${reading ? "block" : "hidden md:block"} min-w-0 overflow-y-auto p-4 md:max-h-[70vh]`}>
                <button
                  type="button"
                  className="mb-4 min-h-touch text-sm text-accent md:hidden"
                  onClick={() => setReading(false)}
                >
                  ← {t("youtube.notes.back")}
                </button>
                {!selected ? (
                  <p className="text-sm text-muted">{t("youtube.notes.select")}</p>
                ) : (
                  <>
                    <h2 className="break-words text-lg font-semibold text-text">{selected.title}</h2>
                    <p className="mt-1 text-xs text-muted">
                      {selected.playlistTitle} ·{" "}
                      {selected.exportedAt
                        ? new Date(selected.exportedAt).toLocaleDateString(i18n.language)
                        : t("youtube.notes.blocked")}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                      <a
                        href={`https://www.youtube.com/watch?v=${encodeURIComponent(selected.videoId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {t("youtube.openOnYoutube")} ↗
                      </a>
                      <span className="break-all text-faint">{selected.notePath}</span>
                    </div>
                    {selected.status === "blocked" ? (
                      <div className="mt-5 rounded-md border border-danger p-4 text-sm text-muted">
                        <strong className="text-danger">{t("youtube.notes.blocked")}</strong>
                        <p className="mt-2">{selected.reason || t("youtube.notes.healthFix")}</p>
                      </div>
                    ) : detail.isError ? (
                      <div className="mt-5">
                        <InlineError onRetry={() => void detail.refetch()} />
                      </div>
                    ) : detail.isLoading || detail.data?.note.videoId !== selectedId ? (
                      <p role="status" className="mt-5 text-sm text-muted">
                        {t("youtube.notes.loading")}
                      </p>
                    ) : (
                      <>
                        <p className="mt-5 text-xs text-faint">{t("youtube.notes.readOnly")}</p>
                        <div className="mt-3 space-y-4 break-words text-sm leading-7 text-text">
                          <ReactMarkdown
                            skipHtml
                            components={{
                              h1: ({ children }) => <h3 className="text-lg font-semibold">{children}</h3>,
                              h2: ({ children }) => (
                                <h3 className="border-b border-border pb-1 font-semibold">{children}</h3>
                              ),
                              p: ({ children }) => <p>{children}</p>,
                              blockquote: ({ children }) => (
                                <blockquote className="border-l-2 border-accent pl-3 text-muted">{children}</blockquote>
                              ),
                              ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
                              li: ({ children }) => <li>{children}</li>,
                              a: ({ href, children }) =>
                                href?.startsWith("https://") || href?.startsWith("http://") ? (
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-accent underline"
                                  >
                                    {children}
                                  </a>
                                ) : (
                                  <span>{children}</span>
                                ),
                              img: () => null,
                            }}
                          >
                            {readableNoteMarkdown(detail.data.content)}
                          </ReactMarkdown>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - PAGE_SIZE));
                setSelectedId(null);
                setReading(false);
              }}
              className="min-h-touch rounded-sm border border-border px-3 disabled:opacity-40"
            >
              {t("youtube.notes.previous")}
            </button>
            <span>
              {t("youtube.notes.range", {
                from: (list.data?.total ?? 0) ? offset + 1 : 0,
                to: offset + notes.length,
                total: list.data?.total ?? 0,
              })}
            </span>
            <button
              type="button"
              disabled={offset + notes.length >= (list.data?.total ?? 0)}
              onClick={() => {
                setOffset(offset + PAGE_SIZE);
                setSelectedId(null);
                setReading(false);
              }}
              className="min-h-touch rounded-sm border border-border px-3 disabled:opacity-40"
            >
              {t("youtube.notes.next")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
