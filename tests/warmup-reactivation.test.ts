import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHealth,
  planReactivation,
  type HealthSignals,
  type HealthVerdict,
} from "../lib/warmup/reactivation.ts";
import {
  rewarmTargetForDay,
  resolveDailyTarget,
  resolvePhaseLabel,
} from "../lib/warmup/types.ts";

// ── evaluateHealth ──────────────────────────────────────────────────────────

const CLEAN: HealthSignals = {
  healthScore: 0.95,
  inboxRate: 0.98,
  blocklistListed: false,
  postmasterRep: null,
};

test("evaluateHealth: strong signals → healthy, no dip", () => {
  const v = evaluateHealth(CLEAN);
  assert.equal(v.dip, false);
  assert.equal(v.healthy, true);
});

test("evaluateHealth: low health score → dip", () => {
  const v = evaluateHealth({ ...CLEAN, healthScore: 0.5 });
  assert.equal(v.dip, true);
  assert.equal(v.healthy, false);
});

test("evaluateHealth: inbox rate 85% (the real-world dip) → dip", () => {
  const v = evaluateHealth({ ...CLEAN, inboxRate: 0.85 });
  assert.equal(v.dip, true);
});

test("evaluateHealth: structural health score ~0.74 (p=none + forwarding) is NOT a dip", () => {
  // The score floor when DMARC is monitoring-only and any forwarding exists.
  // This must stay in the hold band so the loop doesn't re-warm forever on it.
  const v = evaluateHealth({ healthScore: 0.74, inboxRate: 0.97, blocklistListed: false, postmasterRep: null });
  assert.equal(v.dip, false);
  assert.equal(v.healthy, true); // 0.74 >= recover 0.72, inbox 0.97 >= 0.95
});

test("evaluateHealth: a REAL blocklist listing → dip", () => {
  const v = evaluateHealth({ ...CLEAN, blocklistListed: true });
  assert.equal(v.dip, true);
  assert.equal(v.healthy, false);
});

test("evaluateHealth: Postmaster BAD/LOW → dip", () => {
  assert.equal(evaluateHealth({ ...CLEAN, postmasterRep: "BAD" }).dip, true);
  assert.equal(evaluateHealth({ ...CLEAN, postmasterRep: "LOW" }).dip, true);
});

test("evaluateHealth: score dead-band (0.60<score<0.72) is neither dip nor healthy (hysteresis)", () => {
  const v = evaluateHealth({ ...CLEAN, healthScore: 0.66, inboxRate: null });
  assert.equal(v.dip, false);
  assert.equal(v.healthy, false);
});

test("evaluateHealth: inbox dead-band (0.90<rate<0.95) is neither dip nor healthy", () => {
  const v = evaluateHealth({ healthScore: null, inboxRate: 0.92, blocklistListed: false, postmasterRep: null });
  assert.equal(v.dip, false);
  assert.equal(v.healthy, false);
});

test("evaluateHealth: no signals at all → not healthy, not dip (unknown, not a green light)", () => {
  const v = evaluateHealth({
    healthScore: null,
    inboxRate: null,
    blocklistListed: false,
    postmasterRep: null,
  });
  assert.equal(v.dip, false);
  assert.equal(v.healthy, false);
});

test("evaluateHealth: blocklistListed=true blocks 'healthy' even with a great score", () => {
  const v = evaluateHealth({ ...CLEAN, blocklistListed: true });
  assert.equal(v.healthy, false);
});

// ── rewarm target curve ─────────────────────────────────────────────────────

test("rewarmTargetForDay: gentle climb 20 → 30 → 40 → 50 cap", () => {
  assert.equal(rewarmTargetForDay(1), 20);
  assert.equal(rewarmTargetForDay(3), 20);
  assert.equal(rewarmTargetForDay(4), 30);
  assert.equal(rewarmTargetForDay(7), 30);
  assert.equal(rewarmTargetForDay(8), 40);
  assert.equal(rewarmTargetForDay(14), 40);
  assert.equal(rewarmTargetForDay(15), 50);
  assert.equal(rewarmTargetForDay(99), 50);
});

test("resolveDailyTarget: re-warm curve OVERRIDES the day-79 maintenance floor", () => {
  const base = { current_day: 79, rewarm_started_at: null as string | null, rewarm_day: 0 };
  assert.equal(resolveDailyTarget(base), 5); // maintenance
  assert.equal(
    resolveDailyTarget({ ...base, rewarm_started_at: "2026-08-14T00:00:00Z", rewarm_day: 1 }),
    20,
  );
  assert.equal(
    resolveDailyTarget({ ...base, rewarm_started_at: "2026-08-14T00:00:00Z", rewarm_day: 10 }),
    40,
  );
});

test("resolvePhaseLabel: shows re-warm state", () => {
  assert.match(
    resolvePhaseLabel({ current_day: 79, rewarm_started_at: "x", rewarm_day: 2 }),
    /Re-warming · day 2 \(20\/day\)/,
  );
  assert.match(
    resolvePhaseLabel({ current_day: 79, rewarm_started_at: null, rewarm_day: 0 }),
    /Maintenance/,
  );
});

// ── planReactivation ────────────────────────────────────────────────────────

const dip: HealthVerdict = { dip: true, healthy: false, reasons: ["inbox placement 70% (below 80%)"] };
const healthy: HealthVerdict = { dip: false, healthy: true, reasons: [] };
const hold: HealthVerdict = { dip: false, healthy: false, reasons: [] };

test("planReactivation: paused → skip (never ramp into a spam-paused domain)", () => {
  const p = planReactivation({
    status: "paused",
    rewarmStartedAt: null,
    rewarmDay: 0,
    healthyStreak: 0,
    lastHealthEvalDate: null,
    today: "2026-08-14",
    verdict: dip,
  });
  assert.equal(p.kind, "skip");
});

test("planReactivation: already evaluated today → hold (one eval per day)", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: null,
    rewarmDay: 0,
    healthyStreak: 0,
    lastHealthEvalDate: "2026-08-14",
    today: "2026-08-14",
    verdict: dip,
  });
  assert.equal(p.kind, "hold");
});

test("planReactivation: dip while at maintenance → enter re-warm at 20/day", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: null,
    rewarmDay: 0,
    healthyStreak: 0,
    lastHealthEvalDate: "2026-08-13",
    today: "2026-08-14",
    verdict: dip,
  });
  assert.equal(p.kind, "enter");
  if (p.kind === "enter") assert.equal(p.target, 20);
});

test("planReactivation: healthy at maintenance → none", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: null,
    rewarmDay: 0,
    healthyStreak: 0,
    lastHealthEvalDate: "2026-08-13",
    today: "2026-08-14",
    verdict: healthy,
  });
  assert.equal(p.kind, "none");
});

test("planReactivation: in re-warm + dip → advance, day++ and target climbs", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: "2026-08-01T00:00:00Z",
    rewarmDay: 3,
    healthyStreak: 0,
    lastHealthEvalDate: "2026-08-13",
    today: "2026-08-14",
    verdict: dip,
  });
  assert.equal(p.kind, "advance");
  if (p.kind === "advance") {
    assert.equal(p.rewarmDay, 4);
    assert.equal(p.target, 30);
    assert.equal(p.healthyStreak, 0);
  }
});

test("planReactivation: healthy streak reaches exit AND past min days → recover", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: "2026-08-01T00:00:00Z",
    rewarmDay: 6, // → 7 (>= REWARM_MIN_DAYS)
    healthyStreak: 2, // → 3 (>= HEALTHY_STREAK_TO_EXIT)
    lastHealthEvalDate: "2026-08-13",
    today: "2026-08-14",
    verdict: healthy,
  });
  assert.equal(p.kind, "recover");
});

test("planReactivation: healthy streak but BEFORE min days → keep advancing, not recover", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: "2026-08-01T00:00:00Z",
    rewarmDay: 3, // → 4 (< REWARM_MIN_DAYS 7)
    healthyStreak: 2, // → 3
    lastHealthEvalDate: "2026-08-13",
    today: "2026-08-14",
    verdict: healthy,
  });
  assert.equal(p.kind, "advance");
});

test("planReactivation: hits max duration without recovery → abort to maintenance", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: "2026-07-15T00:00:00Z",
    rewarmDay: 29, // → 30 (>= REWARM_MAX_DAYS)
    healthyStreak: 0,
    lastHealthEvalDate: "2026-08-13",
    today: "2026-08-14",
    verdict: dip,
  });
  assert.equal(p.kind, "abort");
});

test("planReactivation: in re-warm, dead-band hold verdict → advance (holds the ramp)", () => {
  const p = planReactivation({
    status: "active",
    rewarmStartedAt: "2026-08-01T00:00:00Z",
    rewarmDay: 5,
    healthyStreak: 1,
    lastHealthEvalDate: "2026-08-13",
    today: "2026-08-14",
    verdict: hold,
  });
  assert.equal(p.kind, "advance");
  if (p.kind === "advance") assert.equal(p.healthyStreak, 0); // not healthy → streak resets
});
