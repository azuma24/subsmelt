import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { acquireStateOwnership, stateDirectories } from "./state-ownership.js";

const moduleUrl = new URL("./state-ownership.ts", import.meta.url).href;

function holder(data: string, config: string) {
  const script = `import { acquireStateOwnership, stateDirectories } from ${JSON.stringify(moduleUrl)};
    const owner = acquireStateOwnership(stateDirectories());
    console.log('READY'); setInterval(() => Boolean(owner), 1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, DATA_DIR: data, CONFIG_DIR: config, CONVERT_BATCH_DIR: path.join(data, "batches") },
    stdio: "pipe",
  });
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });
  return { child, output: () => output };
}

async function ready(process: ReturnType<typeof holder>) {
  const deadline = Date.now() + 10000;
  while (!process.output().includes("READY")) {
    if (process.child.exitCode !== null || Date.now() > deadline)
      throw new Error(process.output() || "Child timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function kill(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

test("ownership excludes shared data/config aliases and releases automatically after SIGKILL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-owner-"));
  const first = holder(path.join(root, "data"), path.join(root, "config"));
  try {
    await ready(first);
    fs.symlinkSync(path.join(root, "data"), path.join(root, "alias-data"));
    fs.symlinkSync(path.join(root, "config"), path.join(root, "alias-config"));
    for (const [data, config] of [
      ["alias-data", "other-config"],
      ["other-data", "alias-config"],
    ]) {
      const second = holder(path.join(root, data), path.join(root, config));
      await once(second.child, "close");
      assert.equal(second.child.exitCode, 1);
      assert.match(second.output(), /state is already in use/);
      assert.equal(second.output().includes("READY"), false);
    }
    await kill(first.child);
    const recovered = acquireStateOwnership(
      stateDirectories({ DATA_DIR: path.join(root, "alias-data"), CONFIG_DIR: path.join(root, "alias-config") }),
    );
    recovered.release();
    recovered.release();
  } finally {
    await kill(first.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("simultaneous owners produce one winner and independent state remains available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-owner-race-"));
  const processes = [
    holder(path.join(root, "data"), path.join(root, "config")),
    holder(path.join(root, "data"), path.join(root, "config")),
  ];
  try {
    await Promise.race(processes.map((entry) => once(entry.child, "close")));
    const winner = processes.find((entry) => entry.child.exitCode === null)!;
    await ready(winner);
    assert.equal(processes.filter((entry) => entry.output().includes("READY")).length, 1);
    const independent = acquireStateOwnership(
      stateDirectories({
        DATA_DIR: path.join(root, "independent-data"),
        CONFIG_DIR: path.join(root, "independent-config"),
      }),
    );
    independent.release();
  } finally {
    await Promise.all(processes.map((entry) => kill(entry.child)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state ownership leaves shared or absent media directories untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subsmelt-media-owner-"));
  try {
    const media = path.join(root, "absent-media");
    const ownership = acquireStateOwnership(
      stateDirectories({ DATA_DIR: path.join(root, "data"), CONFIG_DIR: path.join(root, "config"), MEDIA_DIR: media }),
    );
    ownership.release();
    assert.equal(fs.existsSync(media), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
