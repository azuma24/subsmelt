import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const OWNER_FILE = ".subsmelt-owner.sqlite";

export interface StateDirectories {
  data: string;
  config: string;
  batches: string;
  media: string;
}

export function stateDirectories(env: NodeJS.ProcessEnv = process.env): StateDirectories {
  const data = path.resolve(env.DATA_DIR || "./data");
  return {
    data,
    config: path.resolve(env.CONFIG_DIR || "./config"),
    batches: path.resolve(env.CONVERT_BATCH_DIR || path.join(data, "convert-batches")),
    media: path.resolve(env.MEDIA_DIR || "/media"),
  };
}

export interface StateOwnership {
  directories: StateDirectories;
  release(): void;
}

/** Keep the lock inode forever. Unlinking it could let another process lock a different inode. */
export function acquireStateOwnership(directories: StateDirectories): StateOwnership {
  const canonical = { ...directories };
  const held: Database.Database[] = [];
  try {
    for (const key of ["data", "config", "batches"] as const) {
      fs.mkdirSync(canonical[key], { recursive: true });
      canonical[key] = fs.realpathSync(canonical[key]);
    }
    for (const directory of [...new Set([canonical.data, canonical.config, canonical.batches])].sort()) {
      const file = path.join(directory, OWNER_FILE);
      try {
        fs.closeSync(fs.openSync(file, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
        throw new Error(`Unsafe state ownership file: ${file}`);
      }
      const lock = new Database(file, { timeout: 250 });
      held.push(lock);
      try {
        lock.exec("BEGIN EXCLUSIVE");
        if (lock.pragma("journal_mode", { simple: true }) !== "delete") {
          throw new Error("Ownership database must use rollback journaling");
        }
      } catch (error) {
        throw new Error(`SubSmelt state is already in use, or cannot be locked: ${directory}`, { cause: error });
      }
    }
  } catch (error) {
    for (const lock of held.reverse()) lock.close();
    throw error;
  }
  return {
    directories: canonical,
    release() {
      for (const lock of held.splice(0).reverse()) lock.close();
    },
  };
}
