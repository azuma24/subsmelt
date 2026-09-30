import test from "node:test";
import assert from "node:assert/strict";
import { isPlaylistId, isVideoId, parsePlaylistInput, playlistUrl, videoUrl } from "./urls.js";

const LIST = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";

test("parsePlaylistInput reads the list id from every pasted form", () => {
  assert.equal(parsePlaylistInput(`https://www.youtube.com/playlist?list=${LIST}`), LIST);
  assert.equal(parsePlaylistInput(`https://www.youtube.com/watch?v=qD0_yWgifDM&list=${LIST}&index=3`), LIST);
  assert.equal(
    parsePlaylistInput("https://music.youtube.com/playlist?list=OLAK5uy_nBOkMPYxMAIS6ZqR2ymuzdV5Asl2zfBWY"),
    "OLAK5uy_nBOkMPYxMAIS6ZqR2ymuzdV5Asl2zfBWY",
  );
  assert.equal(parsePlaylistInput(`https://youtu.be/qD0_yWgifDM?list=${LIST}`), LIST);
  assert.equal(parsePlaylistInput("m.youtube.com/playlist?list=UUsooa4yRKGN_zEE8iknghZA"), "UUsooa4yRKGN_zEE8iknghZA");
  assert.equal(parsePlaylistInput(`  ${LIST}  `), LIST);
});

test("parsePlaylistInput drops si= tracking junk", () => {
  assert.equal(parsePlaylistInput(`https://youtube.com/playlist?list=${LIST}&si=Xy_1abcDEF9`), LIST);
  assert.equal(parsePlaylistInput(`youtu.be/qD0_yWgifDM?si=Xy_1abcDEF9&list=${LIST}`), LIST);
});

test("parsePlaylistInput returns null for anything that is not a YouTube playlist", () => {
  assert.equal(parsePlaylistInput(`http://youtube.com/playlist?list=${LIST}`), LIST);
  assert.equal(parsePlaylistInput(""), null);
  assert.equal(parsePlaylistInput("https://vimeo.com/76979871"), null);
  assert.equal(parsePlaylistInput(`https://www.youtube.com.evil.example/playlist?list=${LIST}`), null);
  assert.equal(parsePlaylistInput("https://www.youtube.com/playlist?list=../../etc/passwd"), null);
  assert.equal(parsePlaylistInput("https://www.youtube.com/watch?v=qD0_yWgifDM"), null);
  assert.equal(parsePlaylistInput(`ftp://www.youtube.com/playlist?list=${LIST}`), null);
});

test("canonical URLs are built only from valid ids", () => {
  assert.equal(playlistUrl(LIST), "https://www.youtube.com/playlist?list=PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8");
  assert.equal(videoUrl("qD0_yWgifDM"), "https://www.youtube.com/watch?v=qD0_yWgifDM");
  assert.throws(() => playlistUrl("PL../../x"), /Invalid playlist id/);
  assert.throws(() => videoUrl("qD0_yWgifD"), /Invalid video id/);
});

test("id checks accept YouTube ids and reject the rest", () => {
  assert.equal(isVideoId("qD0_yWgifDM"), true);
  assert.equal(isVideoId("qD0_yWgifDMx"), false);
  assert.equal(isPlaylistId("UUsooa4yRKGN_zEE8iknghZA"), true);
  assert.equal(isPlaylistId("PL short"), false);
});
