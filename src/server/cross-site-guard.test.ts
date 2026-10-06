import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { crossSiteGuard } from "./cross-site-guard.js";

const app = express();
app.use(crossSiteGuard);
let forced = 0;
app.post("/api/jobs/force-all", (_req, res) => {
  forced += 1;
  res.json({ ok: true });
});
app.get("/api/jobs", (_req, res) => res.json({ jobs: [] }));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => server.close());
const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

const forceAll = (headers: Record<string, string>) =>
  fetch(`http://${host}/api/jobs/force-all`, { method: "POST", headers });

test("a bodyless POST another site fires from the browser is refused and does nothing", async () => {
  const before = forced;
  const viaFetchMetadata = await forceAll({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  const viaOriginOnly = await forceAll({ origin: "https://evil.example" });
  const fromSiblingPort = await forceAll({ origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" });
  const fromSandbox = await forceAll({ origin: "null" });

  assert.deepEqual(
    [viaFetchMetadata.status, viaOriginOnly.status, fromSiblingPort.status, fromSandbox.status],
    [403, 403, 403, 403],
  );
  assert.match((await viaOriginOnly.json()).error, /Cross-site request blocked/);
  assert.equal(forced, before);
});

test("the UI's own requests, a typed URL, and scripts without an Origin go through", async () => {
  const before = forced;
  const responses = [
    await forceAll({ origin: `http://${host}`, "sec-fetch-site": "same-origin" }),
    await forceAll({ origin: `http://${host}` }),
    await forceAll({ "sec-fetch-site": "none" }),
    await forceAll({}),
    // Behind a proxy that rewrites Host, the browser's host arrives in X-Forwarded-Host.
    await forceAll({ origin: "https://subs.home.lan", "x-forwarded-host": "subs.home.lan" }),
  ];
  assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(forced, before + 5);
});

test("reads stay open to any origin, since CORS already keeps their responses private", async () => {
  const res = await fetch(`http://${host}/api/jobs`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 200);
});
