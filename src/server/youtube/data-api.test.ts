import test from "node:test";
import assert from "node:assert/strict";
import { fetchAddedDates, testApiKey } from "./data-api.js";

const PL = "PL-Smx9IA029hG4XKsjwo6psQhtDfsosa8";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const item = (videoId: string, publishedAt: string) => ({ snippet: { publishedAt, resourceId: { videoId } } });

test("fetchAddedDates follows nextPageToken and maps each video to its added date", async () => {
  const requested: URL[] = [];
  const pages: Record<string, unknown> = {
    "": { nextPageToken: "CDIQAA", items: [item("uXspbC2srEQ", "2026-09-30T08:12:00Z"), item("BHPDsGVciDk", "2026-09-27T23:59:59Z")] },
    CDIQAA: { items: [item("qN6OM1IzjIE", "2025-01-05T10:00:00Z"), { snippet: { publishedAt: "2025-01-01T00:00:00Z" } }] },
  };
  const fakeFetch = (async (input: URL) => {
    requested.push(input);
    return jsonResponse(200, pages[input.searchParams.get("pageToken") ?? ""]);
  }) as typeof fetch;

  const dates = await fetchAddedDates(PL, "AIzaTestKey", fakeFetch);

  assert.deepEqual([...dates], [
    ["uXspbC2srEQ", "2026-09-30"],
    ["BHPDsGVciDk", "2026-09-27"],
    ["qN6OM1IzjIE", "2025-01-05"],
  ]);
  assert.deepEqual(
    requested.map((u) => [u.pathname, u.searchParams.get("playlistId"), u.searchParams.get("maxResults"), u.searchParams.get("key"), u.searchParams.get("pageToken")]),
    [
      ["/youtube/v3/playlistItems", PL, "50", "AIzaTestKey", null],
      ["/youtube/v3/playlistItems", PL, "50", "AIzaTestKey", "CDIQAA"],
    ],
  );
});

test("fetchAddedDates surfaces Google's error message", async () => {
  const fakeFetch = (async () =>
    jsonResponse(403, { error: { code: 403, message: "The playlist identified with the request's playlistId parameter cannot be found." } })) as typeof fetch;
  await assert.rejects(fetchAddedDates(PL, "AIzaTestKey", fakeFetch), {
    message: "The playlist identified with the request's playlistId parameter cannot be found.",
  });
});

test("testApiKey resolves for an accepted key and throws Google's reason for a bad one", async () => {
  const seen: string[] = [];
  const fakeFetch = (async (input: URL) => {
    const key = input.searchParams.get("key") ?? "";
    seen.push(`${input.pathname}?id=${input.searchParams.get("id")}`);
    return key === "AIzaGood"
      ? jsonResponse(200, { items: [{ id: "dQw4w9WgXcQ" }] })
      : jsonResponse(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key." } });
  }) as typeof fetch;

  await testApiKey("AIzaGood", fakeFetch);
  await assert.rejects(testApiKey("AIzaBad", fakeFetch), { message: "API key not valid. Please pass a valid API key." });
  assert.deepEqual(seen, ["/youtube/v3/videos?id=dQw4w9WgXcQ", "/youtube/v3/videos?id=dQw4w9WgXcQ"]);
});

test("a non-JSON failure falls back to the HTTP status", async () => {
  const fakeFetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
  await assert.rejects(testApiKey("AIzaGood", fakeFetch), { message: "YouTube Data API returned HTTP 502" });
});
