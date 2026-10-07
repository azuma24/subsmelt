import type { Express } from "express";
import { USAGE_RANGES, type UsageCleared, type UsageRange } from "../../shared/usage.js";
import { buildUsageReport, clearUsage } from "../usage.js";

const DEFAULT_RANGE: UsageRange = "30d";

const isUsageRange = (value: unknown): value is UsageRange =>
  typeof value === "string" && (USAGE_RANGES as readonly string[]).includes(value);

export function registerUsageRoutes(app: Express): void {
  app.get("/api/usage", (req, res) => {
    const range = req.query.range ?? DEFAULT_RANGE;
    if (!isUsageRange(range)) {
      res.status(400).json({ error: `range must be one of ${USAGE_RANGES.join(", ")}` });
      return;
    }
    res.json(buildUsageReport(range));
  });

  app.delete("/api/usage", (_req, res) => {
    const cleared: UsageCleared = { ok: true, deleted: clearUsage() };
    res.json(cleared);
  });
}
