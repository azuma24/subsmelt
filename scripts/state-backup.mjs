#!/usr/bin/env node
import path from "node:path";

const usage = `Usage:
  node scripts/state-backup.mjs backup --output /backups/snapshot [--data-dir PATH --config-dir PATH --media-dir PATH --convert-batch-dir PATH]
  node scripts/state-backup.mjs restore --input /backups/snapshot --data-dir PATH --config-dir PATH --media-dir PATH [--convert-batch-dir PATH]

Backup uses DATA_DIR, CONFIG_DIR, MEDIA_DIR and CONVERT_BATCH_DIR unless overridden.
Stop SubSmelt first. Restore requires empty data/config/batch destinations and refuses existing resume files.
Build the server before running this command. See docs/backup-restore.md.`;

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(usage);
  } else {
    if (command !== "backup" && command !== "restore") throw new Error(usage);
    let core;
    try {
      core = await import("../dist/server/state-backup.js");
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND")
        throw new Error("Built server files are missing. Run npm run build first.");
      throw error;
    }
    const { backupState, restoreState } = core;
    const { stateDirectories } = await import("../dist/server/state-ownership.js");
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (
        !new Set(["--output", "--input", "--data-dir", "--config-dir", "--media-dir", "--convert-batch-dir"]).has(
          name,
        ) ||
        !value ||
        value.startsWith("--") ||
        options.has(name)
      ) {
        throw new Error(`Invalid or duplicate argument: ${name}\n${usage}`);
      }
      options.set(name, path.resolve(value));
    }
    const env = { ...process.env };
    for (const [option, variable] of [
      ["--data-dir", "DATA_DIR"],
      ["--config-dir", "CONFIG_DIR"],
      ["--media-dir", "MEDIA_DIR"],
      ["--convert-batch-dir", "CONVERT_BATCH_DIR"],
    ]) {
      if (options.has(option)) env[variable] = options.get(option);
    }
    if (command === "backup") {
      if (!options.has("--output") || options.has("--input")) throw new Error(usage);
      const manifest = await backupState(stateDirectories(env), options.get("--output"));
      console.log(`Backed up ${manifest.files.length} files to ${options.get("--output")}`);
    } else {
      for (const option of ["--input", "--data-dir", "--config-dir", "--media-dir"]) {
        if (!options.has(option)) throw new Error(`Restore requires explicit ${option}\n${usage}`);
      }
      if (options.has("--output")) throw new Error(usage);
      // Restore never inherits a live batch directory from the environment.
      if (!options.has("--convert-batch-dir")) delete env.CONVERT_BATCH_DIR;
      const manifest = restoreState(options.get("--input"), stateDirectories(env));
      console.log(
        `Restored ${manifest.files.length} files. Start SubSmelt with the selected DATA_DIR, CONFIG_DIR, MEDIA_DIR and CONVERT_BATCH_DIR.`,
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
