import { createHash, timingSafeEqual } from "node:crypto";
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
 * then name the host the request was sent to. Requests without these headers
 * are treated as non-browser clients such as curl, scripts, and healthchecks.
 *
 * Host allow-listing and optional Basic authentication are separate ingress guards.
 * Without an allow-list DNS rebinding remains possible.
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
  return (Array.isArray(value) ? value[0] : (value ?? "")).split(",")[0].trim().toLowerCase();
}

export function isCrossSiteRequest(req: Pick<Request, "method" | "headers">, checkSafeMethod = false): boolean {
  if (!checkSafeMethod && SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const fetchSite = firstHeader(req.headers["sec-fetch-site"]);
  if (fetchSite) return !TRUSTED_FETCH_SITES.has(fetchSite);
  const origin = firstHeader(req.headers.origin) || (checkSafeMethod ? firstHeader(req.headers.referer) : "");
  if (!origin) return false;
  const host = originHost(origin);
  if (!host) return true;
  // A reverse proxy that rewrites Host keeps the browser's in X-Forwarded-Host.
  return host !== firstHeader(req.headers.host) && host !== firstHeader(req.headers["x-forwarded-host"]);
}

export function crossSiteGuard(req: Request, res: Response, next: NextFunction): void {
  if (isCrossSiteRequest(req)) rejectCrossSiteRequest(res);
  else next();
}

/** Model discovery also sends an outbound request when called with GET or HEAD. */
export function outboundRequestGuard(req: Request, res: Response, next: NextFunction): void {
  if (isCrossSiteRequest(req, true)) {
    rejectCrossSiteRequest(res);
    return;
  }
  const fetchSite = firstHeader(req.headers["sec-fetch-site"]);
  const fromApp =
    fetchSite === "same-origin" ||
    (!fetchSite && (firstHeader(req.headers.origin) || firstHeader(req.headers.referer)));
  // On HTTP LAN addresses browsers can omit fetch metadata, and a foreign
  // page can suppress its referrer. Require an explicit client header in that case.
  if (fromApp || firstHeader(req.headers["x-subsmelt-client"]) === "cli") {
    next();
  } else {
    res.status(403).json({ error: "Legacy model discovery requires a same-origin request or X-SubSmelt-Client: cli" });
  }
}

function rejectCrossSiteRequest(res: Response): void {
  res
    .status(403)
    .json({ error: "Cross-site request blocked: change settings and start work from the SubSmelt page itself" });
}

/** Optional ingress controls. Host is checked on every request, not forwarded
 * headers: a reverse proxy must preserve the public Host and block direct access. */
export function createIngressGuard(env: NodeJS.ProcessEnv) {
  const rawHosts = env.SUBSMELT_ALLOWED_HOSTS;
  const hosts = rawHosts === undefined ? null : rawHosts.split(",").map((h) => h.trim().toLowerCase());
  if (hosts?.some((h) => !h || !validAuthority(h))) {
    throw new Error("SUBSMELT_ALLOWED_HOSTS must be a comma-separated list of hostnames or IPs with optional ports");
  }
  const user = env.SUBSMELT_BASIC_USER;
  const password = env.SUBSMELT_BASIC_PASSWORD;
  if (
    (user === undefined) !== (password === undefined) ||
    (user !== undefined && (!user || !password || user.includes(":")))
  ) {
    throw new Error(
      "Set both SUBSMELT_BASIC_USER and SUBSMELT_BASIC_PASSWORD to nonempty values; username cannot contain a colon",
    );
  }
  const expected = user === undefined ? null : digest(`${user}:${password}`);
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host?.toLowerCase();
    if (hosts && (!host || !validAuthority(host) || !hosts.includes(host))) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
    if (expected) {
      const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization || "");
      const credentials = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
      if (!timingSafeEqual(expected, digest(credentials))) {
        res.setHeader("WWW-Authenticate", 'Basic realm="SubSmelt", charset="UTF-8"');
        res.status(401).json({ error: "Authentication required" });
        return;
      }
    }
    next();
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function validAuthority(value: string): boolean {
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    if (value.startsWith("[")) return !!url.hostname;
    const hostname = value.split(":")[0].replace(/\.$/, "");
    return (
      hostname.length <= 253 &&
      hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    );
  } catch {
    return false;
  }
}
