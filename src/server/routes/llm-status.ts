import type { Express } from "express";
import { getAllSettings, isLlmConfigured } from "../config.js";
import { resolveConnectionPool } from "../connections.js";
import { buildLlmStatus, createReachabilityProbe } from "../llm-status.js";
import { getActiveJobConnections, getOfflineConnectionIds } from "../queue.js";

// One probe cache for the whole server, so every open tab shares it.
const probe = createReachabilityProbe();

export function registerLlmStatusRoutes(app: Express): void {
  app.get("/api/llm/status", async (_req, res) => {
    const { mode, pool } = resolveConnectionPool(getAllSettings());
    // A fresh install still resolves the shipped placeholder connection;
    // reporting it would show a "Local" machine nobody set up.
    const configured = isLlmConfigured() ? pool.filter((conn) => conn.model) : [];
    res.json(
      await buildLlmStatus({
        mode,
        pool: configured,
        activeJobs: getActiveJobConnections(),
        offlineIds: getOfflineConnectionIds(),
        probe,
      }),
    );
  });
}
