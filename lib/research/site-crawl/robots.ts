/**
 * robots.txt, minimally: the group for our agent token (else `*`), Allow and
 * Disallow as path prefixes with `*` and `$`, longest match wins (RFC 9309).
 * No robots.txt, or one we cannot read, allows everything. A disallowed page
 * is not fetched; the crawl records it as unreadable, so absences become null.
 */

import { CRAWL_USER_AGENT, ROBOTS_AGENT } from "./fetch-page.ts";

export type RobotsRules = { allow: string[]; disallow: string[] };
export type FetchRobots = (origin: string, timeoutMs: number) => Promise<RobotsRules>;

export const ROBOTS_TIMEOUT_MS = 3_000;
const MAX_ROBOTS_BYTES = 200_000;
export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [] };

export function parseRobots(txt: string, agent = ROBOTS_AGENT): RobotsRules {
  const groups: Array<{ agents: string[]; rules: RobotsRules }> = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.rules.allow.push(value);
    if (key === "disallow" && value) current.rules.disallow.push(value);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a === agent));
  const chosen = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: chosen.flatMap((g) => g.rules.allow),
    disallow: chosen.flatMap((g) => g.rules.disallow),
  };
}

function ruleMatch(rule: string, path: string): number {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp(`^${body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
  return re.test(path) ? body.length : -1;
}

export function robotsAllows(rules: RobotsRules, url: string): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
  } catch {
    return false;
  }
  const best = (list: string[]) => Math.max(-1, ...list.map((r) => ruleMatch(r, path)));
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  return disallow < 0 || allow >= disallow;
}

export const fetchRobots: FetchRobots = async (origin, timeoutMs) => {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": CRAWL_USER_AGENT, Accept: "text/plain,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !/text\/plain/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => undefined);
      return ALLOW_ALL;
    }
    const txt = await res.text();
    return parseRobots(txt.slice(0, MAX_ROBOTS_BYTES));
  } catch {
    return ALLOW_ALL;
  }
};
