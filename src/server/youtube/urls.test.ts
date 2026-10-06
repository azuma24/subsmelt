import test from "node:test";
import assert from "node:assert/strict";
import { isChannelUploads, isPlaylistId, isVideoId, parseChannelInput, parsePlaylistInput, playlistUrl, uploadsPlaylistId, videoUrl } from "./urls.js";

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

const CHANNEL = "UCXuqSBlHAE6Xw-yeJA0Tunw";

test("parseChannelInput reads a channel id straight from /channel/ links and bare ids", () => {
  assert.deepEqual(parseChannelInput(`https://www.youtube.com/channel/${CHANNEL}`), { channelId: CHANNEL });
  assert.deepEqual(parseChannelInput(`youtube.com/channel/${CHANNEL}/videos?si=abc`), { channelId: CHANNEL });
  assert.deepEqual(parseChannelInput(`  ${CHANNEL} `), { channelId: CHANNEL });
});

test("parseChannelInput turns handles and legacy names into a canonical URL to resolve", () => {
  assert.deepEqual(parseChannelInput("https://www.youtube.com/@LinusTechTips"), { url: "https://www.youtube.com/@LinusTechTips" });
  assert.deepEqual(parseChannelInput("m.youtube.com/@LinusTechTips/videos"), { url: "https://www.youtube.com/@LinusTechTips" });
  assert.deepEqual(parseChannelInput("@LinusTechTips"), { url: "https://www.youtube.com/@LinusTechTips" });
  assert.deepEqual(parseChannelInput("https://www.youtube.com/c/LinusTechTips"), { url: "https://www.youtube.com/c/LinusTechTips" });
  assert.deepEqual(parseChannelInput("https://www.youtube.com/user/LinusTechTips/featured"), { url: "https://www.youtube.com/user/LinusTechTips" });
});

test("parseChannelInput returns null for anything that is not a YouTube channel", () => {
  assert.equal(parseChannelInput(""), null);
  assert.equal(parseChannelInput(`https://www.youtube.com/playlist?list=${LIST}`), null);
  assert.equal(parseChannelInput("https://www.youtube.com/watch?v=qD0_yWgifDM"), null);
  assert.equal(parseChannelInput("https://www.youtube.com.evil.example/@LinusTechTips"), null);
  assert.equal(parseChannelInput("https://www.youtube.com/@../../etc"), null);
  assert.equal(parseChannelInput("https://www.youtube.com/channel/UCshort"), null);
});

test("a channel's uploads playlist is its id with UU for UC", () => {
  assert.equal(uploadsPlaylistId(CHANNEL), "UUXuqSBlHAE6Xw-yeJA0Tunw");
  assert.equal(isChannelUploads("UUXuqSBlHAE6Xw-yeJA0Tunw"), true);
  assert.equal(isChannelUploads(LIST), false);
  assert.throws(() => uploadsPlaylistId("PL123"), /Invalid channel id/);
});

test("parseChannelInput accepts handles in any script, as typed or percent-encoded", () => {
  assert.deepEqual(parseChannelInput("https://www.youtube.com/@한국어채널"), { url: "https://www.youtube.com/@%ED%95%9C%EA%B5%AD%EC%96%B4%EC%B1%84%EB%84%90" });
  assert.deepEqual(parseChannelInput("https://www.youtube.com/@%ED%95%9C%EA%B5%AD%EC%96%B4%EC%B1%84%EB%84%90/videos"), { url: "https://www.youtube.com/@%ED%95%9C%EA%B5%AD%EC%96%B4%EC%B1%84%EB%84%90" });
  assert.deepEqual(parseChannelInput("@李"), { url: "https://www.youtube.com/@%E6%9D%8E" });
  assert.equal(parseChannelInput("https://www.youtube.com/@a b"), null);
});
