import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSampleLanguage, detectChineseVariant } from "./detect-language";

test("detects Japanese from kana text", () => {
  assert.equal(detectSampleLanguage("こんにちは、世界。これは日本語の字幕です。今日はいい天気ですね。"), "ja");
});

test("detects English", () => {
  assert.equal(detectSampleLanguage("The quick brown fox jumps over the lazy dog and keeps on running far away."), "en");
});

test("detects Korean", () => {
  assert.equal(detectSampleLanguage("안녕하세요. 이것은 한국어 자막입니다. 오늘 날씨가 정말 좋네요."), "ko");
});

test("Chinese resolves to a concrete variant via the character heuristic", () => {
  assert.equal(detectSampleLanguage("这是简体中文的字幕内容。我们对时间没有问题。学习读写很重要。"), "zh-CN");
  assert.equal(detectSampleLanguage("這是繁體中文的字幕內容。我們對時間沒有問題。學習讀寫很重要。"), "zh-TW");
});

test("too-short or gibberish text returns null instead of a wrong guess", () => {
  assert.equal(detectSampleLanguage(""), null);
  assert.equal(detectSampleLanguage("ok"), null);
});

test("detectChineseVariant counts distinctive characters", () => {
  assert.equal(detectChineseVariant("简体对时间发这"), "zh-CN");
  assert.equal(detectChineseVariant("簡體對時間發這"), "zh-TW");
});
