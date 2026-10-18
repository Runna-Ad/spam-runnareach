import assert from "node:assert/strict";
import test from "node:test";
import {
  DO_NOT_SEND_STATUSES,
  PROSPECT_STATUSES,
  mayOverwriteStatus,
  protectedStatusFilter,
  type StatusWriter,
} from "../lib/prospects/status.ts";

const WRITERS: StatusWriter[] = ["automation", "person"];
const OUTCOMES = new Set(["won", "lost"]);

/** Parses "(a,b,c)" into a set so guards can be compared regardless of order. */
function filterSet(f: string | null): Set<string> {
  if (f === null) return new Set();
  assert.match(f, /^\([a-z_]+(,[a-z_]+)*\)$/);
  return new Set(f.slice(1, -1).split(","));
}

function each(fn: (current: string, next: string, by: StatusWriter) => void): void {
  for (const current of PROSPECT_STATUSES) {
    for (const next of PROSPECT_STATUSES) {
      for (const by of WRITERS) fn(current, next, by);
    }
  }
}

const personOutcome = (next: string, by: StatusWriter) => by === "person" && OUTCOMES.has(next);

test("I1: an automated writer never moves a prospect out of won or lost", () => {
  each((current, next, by) => {
    if (by === "automation" && OUTCOMES.has(current) && next !== current) {
      assert.equal(mayOverwriteStatus(current, next, by), false, `${current}→${next}`);
    }
  });
});

test("I2: booked is overwritten only by won or lost", () => {
  each((current, next, by) => {
    if (current === "booked" && next !== "booked") {
      assert.equal(mayOverwriteStatus(current, next, by), OUTCOMES.has(next), `${current}→${next} by ${by}`);
    }
  });
});

test("I3: suppressed never overwrites booked, won, lost", () => {
  for (const by of WRITERS) {
    for (const current of ["booked", "won", "lost"]) {
      assert.equal(mayOverwriteStatus(current, "suppressed", by), false, `${current} by ${by}`);
    }
  }
});

test("I4: replied never overwrites archived_no_meeting, suppressed, booked, won, lost", () => {
  for (const by of WRITERS) {
    for (const current of ["archived_no_meeting", "suppressed", "booked", "won", "lost"]) {
      assert.equal(mayOverwriteStatus(current, "replied", by), false, `${current} by ${by}`);
    }
  }
});

test("I5: no write makes a do-not-send prospect sendable", () => {
  each((current, next, by) => {
    if (DO_NOT_SEND_STATUSES.has(current) && !DO_NOT_SEND_STATUSES.has(next)) {
      assert.equal(mayOverwriteStatus(current, next, by), false, `${current}→${next} by ${by}`);
    }
  });
});

test("I6: a person may set won/lost over anything, nothing else is relaxed", () => {
  each((current, next) => {
    if (OUTCOMES.has(next)) assert.equal(mayOverwriteStatus(current, next, "person"), true, `${current}→${next}`);
    else assert.equal(mayOverwriteStatus(current, next, "person"), mayOverwriteStatus(current, next, "automation"));
  });
  assert.equal(mayOverwriteStatus("won", "lost", "person"), true);
  assert.equal(mayOverwriteStatus("lost", "won", "person"), true);
  assert.equal(mayOverwriteStatus("won", "booked", "person"), false);
});

test("negative set: a prospect in any status outside I1-I5 takes every write", () => {
  each((current, next, by) => {
    if (!DO_NOT_SEND_STATUSES.has(current)) {
      assert.equal(mayOverwriteStatus(current, next, by), true, `${current}→${next} by ${by}`);
    }
  });
});

test("exact table: allowed iff no invariant forbids it (the rule has no extra blocks)", () => {
  each((current, next, by) => {
    const forbidden =
      current !== next &&
      !personOutcome(next, by) &&
      (OUTCOMES.has(current) ||
        (current === "booked" && !OUTCOMES.has(next)) ||
        (DO_NOT_SEND_STATUSES.has(current) && !DO_NOT_SEND_STATUSES.has(next)));
    assert.equal(mayOverwriteStatus(current, next, by), !forbidden, `${current}→${next} by ${by}`);
  });
});

test("null/undefined current status is always writable; same status is a no-op", () => {
  for (const next of PROSPECT_STATUSES) {
    for (const by of WRITERS) {
      assert.equal(mayOverwriteStatus(null, next, by), true);
      assert.equal(mayOverwriteStatus(undefined, next, by), true);
      assert.equal(mayOverwriteStatus(next, next, by), true);
    }
  }
});

test("DO_NOT_SEND_STATUSES are all real enum values", () => {
  for (const s of DO_NOT_SEND_STATUSES) assert.ok((PROSPECT_STATUSES as readonly string[]).includes(s), s);
});

test("protectedStatusFilter is mayOverwriteStatus over the full list", () => {
  each((current, next, by) => {
    assert.equal(filterSet(protectedStatusFilter(next, by)).has(current), !mayOverwriteStatus(current, next, by));
  });
});

test("guard strings: opt-out suppress = today's (won,booked,lost)", () => {
  assert.deepEqual(filterSet(protectedStatusFilter("suppressed", "automation")), filterSet("(won,booked,lost)"));
});

test("guard strings: calendar-sync booked = (won,lost)", () => {
  assert.deepEqual(filterSet(protectedStatusFilter("booked", "automation")), filterSet("(won,lost)"));
});

test("guard strings: poll replied = today's list plus no_match (I5: replied is sendable)", () => {
  assert.deepEqual(
    filterSet(protectedStatusFilter("replied", "automation")),
    filterSet("(archived_no_meeting,suppressed,booked,won,lost,no_match)"),
  );
});

test("intent-actions: wants_meeting leaves won/lost alone, bounce leaves booked/won/lost alone", () => {
  const book = filterSet(protectedStatusFilter("booked", "person"));
  assert.ok(book.has("won") && book.has("lost"));
  assert.equal(mayOverwriteStatus("won", "booked", "person"), false);
  const bounce = filterSet(protectedStatusFilter("suppressed", "person"));
  assert.deepEqual(bounce, filterSet("(booked,won,lost)"));
  assert.equal(mayOverwriteStatus("booked", "suppressed", "person"), false);
  // Opportunity outcomes (lib/opportunities/actions.ts) are never blocked.
  assert.equal(protectedStatusFilter("won", "person"), null);
  assert.equal(protectedStatusFilter("lost", "person"), null);
});
