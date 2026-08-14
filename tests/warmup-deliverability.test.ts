import assert from "node:assert/strict";
import test from "node:test";
import { classifyBlocklistAnswer } from "../lib/warmup/deliverability.ts";

// A real Spamhaus DBL listing.
test("classifyBlocklistAnswer: 127.0.1.2 is a real DBL listing", () => {
  assert.equal(classifyBlocklistAnswer(["127.0.1.2"]), "listed");
});

test("classifyBlocklistAnswer: 127.0.1.106 (top of DBL range) is listed", () => {
  assert.equal(classifyBlocklistAnswer(["127.0.1.106"]), "listed");
});

test("classifyBlocklistAnswer: SURBL 127.0.0.x bitmask is listed", () => {
  assert.equal(classifyBlocklistAnswer(["127.0.0.64"]), "listed");
});

// The bug this fixes: querying Spamhaus via a public resolver (8.8.8.8 / 1.1.1.1)
// returns an error sentinel, NOT a listing. runnareach.com hit exactly this.
test("classifyBlocklistAnswer: 127.255.255.254 (open resolver) is an ERROR, not a listing", () => {
  assert.equal(classifyBlocklistAnswer(["127.255.255.254"]), "error");
});

test("classifyBlocklistAnswer: 127.255.255.252 (anonymous query) is an error", () => {
  assert.equal(classifyBlocklistAnswer(["127.255.255.252"]), "error");
});

test("classifyBlocklistAnswer: 127.255.255.255 (excessive queries) is an error", () => {
  assert.equal(classifyBlocklistAnswer(["127.255.255.255"]), "error");
});

test("classifyBlocklistAnswer: empty answer (NXDOMAIN handled upstream) is not listed", () => {
  assert.equal(classifyBlocklistAnswer([]), "not_listed");
});

// A real listing alongside an error still counts as listed (any real hit wins).
test("classifyBlocklistAnswer: a real listing mixed with an error still reads as listed", () => {
  assert.equal(classifyBlocklistAnswer(["127.255.255.254", "127.0.1.2"]), "listed");
});
