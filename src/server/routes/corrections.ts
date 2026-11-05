import type { Express } from "express";
import { parseCorrectionRule, normalizeCorrectionPath, type CorrectionRule } from "../../shared/corrections.js";
import { scanFolder } from "../scanner.js";
import { applyCorrections, scanForCorrections } from "../corrections-scan.js";
import { runQueueSafely } from "../queue.js";
import { logger } from "../logger.js";
import { errorMessage } from "../errors.js";

const MAX_RULES = 200;
const MAX_FILES = 2000;

function rulesFrom(body: unknown): CorrectionRule[] {
  const raw = (body as { rules?: unknown })?.rules;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("rules must be a non-empty array");
  if (raw.length > MAX_RULES) throw new Error(`at most ${MAX_RULES} rules`);
  return raw.map((rule, i) => {
    const parsed = parseCorrectionRule({ id: `rule-${i}`, ...(rule as object) });
    if (!parsed) throw new Error("invalid rule");
    return parsed;
  });
}

function stringsFrom(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw new Error(`${name} must be an array of strings`);
  if (value.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} ${name}`);
  return value;
}

/**
 * Subtitle corrections on files already in the library: a dry run that lists
 * what some rules would change, and the apply step for the files a person
 * ticked. Saving the rules themselves is an ordinary settings save.
 */
export function registerCorrectionsRoutes(app: Express): void {
  app.post("/api/corrections/scan", async (req, res) => {
    try {
      const rules = rulesFrom(req.body);
      const files = stringsFrom(req.body?.files, "files");
      const folders = stringsFrom(req.body?.folders, "folders")?.map((f) => {
        const folder = normalizeCorrectionPath(f);
        if (folder === null) throw new Error(`folder outside the media folder: ${f}`);
        return folder;
      });
      if (!files && !folders) throw new Error("give folders or files");
      res.json(scanForCorrections(await scanFolder(false), rules, { files, folders }));
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/corrections/apply", async (req, res) => {
    try {
      const rules = rulesFrom(req.body);
      const files = stringsFrom(req.body?.files, "files");
      if (!files?.length) throw new Error("files must be a non-empty array");
      const report = applyCorrections(await scanFolder(false), rules, files, req.body?.retranslate === true);
      const failed = report.results.filter((r) => r.error).length;
      logger.info(
        "translate",
        `Corrections applied: ${report.totalFixed} replacement${report.totalFixed === 1 ? "" : "s"} in ${
          report.results.filter((r) => r.total > 0).length
        } file(s)${failed ? `, ${failed} not changed` : ""}${report.retranslated ? `, ${report.retranslated} translation(s) queued again` : ""}`,
        undefined,
        { stage: "corrections", rules: rules.map((r) => `${r.find} → ${r.replace}`) },
      );
      if (report.retranslated > 0) setTimeout(() => runQueueSafely(), 100);
      res.json(report);
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });
}
