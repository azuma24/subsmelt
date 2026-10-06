import type { NextFunction, Request, Response } from "express";

/**
 * Rejects state-changing requests that another website fired from the user's
 * browser.
 *
 * The API has no login: it trusts whoever can reach it on the LAN. CORS stops a
 * foreign page from reading responses, but not from sending a "simple" request
 * (a bodyless POST with mode: "no-cors"), and endpoints like /api/jobs/force-all
 * act on those alone, re-translating the whole library on cloud credit.
 *
 * Browsers say where a request came from. Sec-Fetch-Site is the most direct
 * answer and is trusted when present: only "same-origin" (the bundled UI) and
 * "none" (typed by the user) pass. Older browsers send only Origin, which must
 * then name the host the request was sent to. A request with neither header did
 * not come from a web page (curl, scripts, the healthcheck) and passes.
 *
 * Not covered: DNS rebinding. A page on a domain the attacker re-points at this
 * server's IP is same-origin as far as the browser knows, so both headers pass.
 * Defending against that needs an allow-list of the names the server is reached
 * by, which a LAN install reached by IP, hostname or reverse proxy cannot know
 * in advance. Keep the server off the public internet.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TRUSTED_FETCH_SITES = new Set(["same-origin", "none"]);

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function firstHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value ?? "").split(",")[0].trim().toLowerCase();
}

export function isCrossSiteRequest(req: Pick<Request, "method" | "headers">): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const fetchSite = firstHeader(req.headers["sec-fetch-site"]);
  if (fetchSite) return !TRUSTED_FETCH_SITES.has(fetchSite);
  const origin = firstHeader(req.headers.origin);
  if (!origin) return false;
  const host = originHost(origin);
  if (!host) return true;
  // A reverse proxy that rewrites Host keeps the browser's in X-Forwarded-Host.
  return host !== firstHeader(req.headers.host) && host !== firstHeader(req.headers["x-forwarded-host"]);
}

export function crossSiteGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isCrossSiteRequest(req)) return next();
  res.status(403).json({ error: "Cross-site request blocked: change settings and start work from the SubSmelt page itself" });
}
