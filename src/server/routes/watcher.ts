import type { Express, Request, Response } from "express";
import { getConfigLoadFailure } from "../config.js";
import { getWatcherStatus, setWatcherEnabled } from "../watcher.js";

export function registerWatcherRoutes(app: Express): void {
  const setEnabled = (enabled: boolean) => (_req: Request, res: Response) => {
    if (getConfigLoadFailure()) {
      return res.status(409).json({ error: "Repair or replace the unreadable configuration in Settings first." });
    }
    res.json({ ok: true, ...setWatcherEnabled(enabled) });
  };

  app.post("/api/watcher/start", setEnabled(true));
  app.post("/api/watcher/stop", setEnabled(false));
  app.get("/api/watcher/status", (_req, res) => res.json(getWatcherStatus()));
}
