import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../../test-render";
import type { YoutubePlaylist } from "../../types";
import { FollowPlaylistDialog } from "./FollowPlaylistDialog";
import { PlaylistList } from "./PlaylistList";
import type { usePlaylistActions } from "./usePlaylistActions";

const playlist = (secondBrainExport: boolean): YoutubePlaylist => ({
  id: "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8",
  title: "AI",
  folder: "AI",
  enabled: true,
  mode: "auto",
  backfill: { kind: "none" },
  media: { type: "audio", format: "m4a" },
  captions: "prefer_youtube",
  subtitleTaskIds: [],
  checkEveryMinutes: 60,
  include: { shorts: false, live: false },
  secondBrainExport,
  sync: { lastCheckedAt: null, lastError: null, count: null, availability: null, checking: false, nextCheckAt: null },
  counts: { total: 0, removed: 0, byStatus: {}, byKind: {} },
});

const dialog = (edited?: YoutubePlaylist) =>
  renderPage(
    <FollowPlaylistDialog
      playlist={edited}
      tasks={[]}
      hasApiKey={false}
      folderRoot="/media/YouTube"
      onClose={() => undefined}
      onOpenSettings={() => undefined}
      onSaved={() => undefined}
    />,
  );

const secondBrainBox = (html: string) => {
  const label = html.indexOf("Enable for knowledge base");
  const input = html.lastIndexOf("<input", label);
  return html.slice(input, html.indexOf(">", input) + 1);
};

test("the knowledge-base choice sits outside More, unchecked for a new follow, with its hint", () => {
  const { html, text } = dialog();
  assert.ok(html.indexOf("Enable for knowledge base") < html.indexOf("<details"));
  assert.doesNotMatch(secondBrainBox(html), /checked/);
  assert.match(text, /nothing is copied or indexed yet\./);
});

test("editing shows the playlist's saved second-brain choice", () => {
  assert.match(secondBrainBox(dialog(playlist(true)).html), /checked/);
  assert.doesNotMatch(secondBrainBox(dialog(playlist(false)).html), /checked/);
});

test("the playlist list tags only playlists selected for the second brain", () => {
  const actions = { isChecking: () => false } as unknown as ReturnType<typeof usePlaylistActions>;
  const list = (selected: boolean) =>
    renderPage(
      <PlaylistList
        playlists={[playlist(selected)]}
        folderRoot="/media/YouTube"
        actions={actions}
        onOpen={() => undefined}
        onEdit={() => undefined}
      />,
    ).text;
  assert.equal((list(true).match(/Selected for knowledge base/g) ?? []).length, 2);
  assert.equal((list(false).match(/Selected for knowledge base/g) ?? []).length, 1);
});
