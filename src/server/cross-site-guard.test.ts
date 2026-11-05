import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import http from "node:http";
import express from "express";
import { crossSiteGuard, createIngressGuard } from "./cross-site-guard.js";

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
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200, 200, 200, 200],
  );
  assert.equal(forced, before + 5);
});

test("reads stay open to any origin, since CORS already keeps their responses private", async () => {
  const res = await fetch(`http://${host}/api/jobs`, {
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 200);
});

test("ingress allow-list and authentication protect reads, writes, and static content", async () => {
  const guarded = express();
  guarded.use(
    createIngressGuard({
      SUBSMELT_ALLOWED_HOSTS: "subs.example, [::1]:3000",
      SUBSMELT_BASIC_USER: "user",
      SUBSMELT_BASIC_PASSWORD: "correct",
    }),
  );
  guarded.use((_req, res) => res.send("private"));
  const listener = guarded.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as AddressInfo).port;
  const auth = `Basic ${Buffer.from("user:correct").toString("base64")}`;
  const request = (host: string, authorization?: string, method = "GET", forwarded?: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method,
          headers: {
            host,
            ...(authorization ? { authorization } : {}),
            ...(forwarded ? { "x-forwarded-host": forwarded } : {}),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal(await request("evil.example", auth, "GET", "subs.example"), 403);
    assert.equal(await request("subs.example"), 401);
    assert.equal(await request("subs.example", `Basic ${Buffer.from("user:wrong").toString("base64")}`, "POST"), 401);
    assert.equal(await request("subs.example", auth), 200);
    assert.equal(await request("[::1]:3000", auth), 200);
  } finally {
    listener.close();
  }
});

test("ingress configuration fails closed on malformed or incomplete settings", () => {
  for (const env of [
    { SUBSMELT_ALLOWED_HOSTS: "" },
    { SUBSMELT_ALLOWED_HOSTS: "*.example" },
    { SUBSMELT_ALLOWED_HOSTS: "." },
    { SUBSMELT_ALLOWED_HOSTS: "foo..example" },
    { SUBSMELT_ALLOWED_HOSTS: "-bad.example" },
    { SUBSMELT_ALLOWED_HOSTS: "[::1]:65536" },
    { SUBSMELT_ALLOWED_HOSTS: "[not-ip]:3000" },
    { SUBSMELT_BASIC_USER: "user" },
    { SUBSMELT_BASIC_USER: "user", SUBSMELT_BASIC_PASSWORD: "" },
  ])
    assert.throws(() => createIngressGuard(env));
});
