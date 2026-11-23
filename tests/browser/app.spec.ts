import fs from "node:fs";
import { test, expect } from "./fixtures";

test("connection edits survive a browser reload", async ({ page, app }) => {
  await page.goto(`${app.url}/settings`);
  const name = page.getByLabel("Connection name", { exact: true });
  await expect(name).toHaveValue("Browser connection");
  await name.fill("Saved browser connection");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => JSON.parse((await app.settings()).llm_connections)[0].label)
    .toBe("Saved browser connection");
  await page.reload();
  await expect(name).toHaveValue("Saved browser connection");
});

test("a failed settings save retains edits and can be retried", async ({ page, app }) => {
  await page.goto(`${app.url}/settings`);
  const name = page.getByLabel("Connection name", { exact: true });
  await expect(name).toHaveValue("Browser connection");
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Browser-test save failure" }),
      });
    } else await route.continue();
  });
  await name.fill("Retained browser connection");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Save failed: Browser-test save failure", { exact: true })).toBeVisible();
  await expect(name).toHaveValue("Retained browser connection");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.unroute("**/api/settings");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => JSON.parse((await app.settings()).llm_connections)[0].label)
    .toBe("Retained browser connection");
  await page.reload();
  await expect(name).toHaveValue("Retained browser connection");
});

test("Stop interrupts a running translation and leaves it ready to resume", async ({ page, app }) => {
  const id = await app.enqueue("Stop example.srt");
  await page.goto(app.url);
  await expect.poll(app.heldCalls).toBeGreaterThan(0);
  await page.getByRole("button", { name: /Stop$/ }).click();
  await expect.poll(async () => (await app.jobs()).find((job) => job.id === id)?.status).toBe("pending");
  await expect(page.getByRole("button", { name: /Run All/ })).toBeVisible();
  expect(fs.existsSync((await app.jobs()).find((job) => job.id === id)!.output_path)).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: /Run All/ })).toBeVisible();
});

test("Cancel ends an individual translation and keeps its cancelled state", async ({ page, app }) => {
  const id = await app.enqueue("Cancel example.srt");
  await page.goto(app.url);
  await expect.poll(app.heldCalls).toBeGreaterThan(0);
  const row = page.getByRole("row").filter({ hasText: "Cancel example.srt" });
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(async () => (await app.jobs()).find((job) => job.id === id)?.error).toBe("Cancelled by user");
  await page.reload();
  await expect(row.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect((await app.jobs()).find((job) => job.id === id)?.status).toBe("error");
});

test("a job that started before live updates connected shows as running", async ({ page, app }) => {
  const id = await app.enqueue("Early example.srt");
  await expect.poll(app.heldCalls).toBeGreaterThan(0);
  // The first list the page loads predates the start, whose event it never received.
  await page.route(
    "**/api/jobs",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { jobs: { id: number; status: string }[] };
      for (const job of body.jobs) if (job.id === id) job.status = "pending";
      await route.fulfill({ response, json: body });
    },
    { times: 1 },
  );
  await page.goto(app.url);
  const row = page.getByRole("row").filter({ hasText: "Early example.srt" });
  await expect(row.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
});

test("the open browser reconciles job state after the server reconnects", async ({ page, app }) => {
  const id = await app.enqueue("Reconnect example.srt");
  await page.goto(app.url);
  await expect.poll(app.heldCalls).toBeGreaterThan(0);
  await page.getByRole("button", { name: /Stop$/ }).click();
  await expect.poll(async () => (await app.jobs()).find((job) => job.id === id)?.status).toBe("pending");
  await expect(page.getByRole("button", { name: /Run All/ })).toBeVisible();
  await app.stop();
  app.completeWhileStopped(id);
  const reconnected = page.waitForResponse(
    (response) => response.url() === `${app.url}/api/events` && response.status() === 200,
  );
  await app.start();
  await reconnected;
  const row = page.getByRole("row").filter({ hasText: "Reconnect example.srt" });
  await expect(row.getByText("Done", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Run All/ })).toHaveCount(0);
});
