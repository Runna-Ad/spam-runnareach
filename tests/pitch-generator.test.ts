import assert from "node:assert/strict";
import test from "node:test";
import {
  composePitchHeuristic,
  type GeneratorInputs,
} from "../lib/pitches/generator.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function fullInputs(over: Partial<GeneratorInputs> = {}): GeneratorInputs {
  return {
    prospect: {
      id: "p1",
      company_name: "Calgary Coffee Roasters",
      industry: "DTC coffee",
      language: "en",
      employee_size_estimate: null,
      city: null,
      market: null,
      what_they_do: null,
      tech_stack: [],
    },
    pains: [
      {
        pain_id: "pain-mobile",
        pain_label: "Poor mobile conversion",
        evidence_quote: "mobile checkout takes 3 screens and breaks on iPhone",
      },
    ],
    contacts: [
      {
        full_name: "Sarah Lee",
        email: "sarah@ccr.example",
        email_is_role_based: false,
        role_title: null,
      },
    ],
    case_studies: [
      {
        id: "cs-didi",
        client_name: "DiDi",
        industry: "DTC marketplace",
        hero_metric_en: "+47% mobile checkout completion in 30 days",
        hero_metric_es: "+47% checkout móvil completado en 30 días",
        result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 0.9, tier: "smb" as const,
      },
      {
        id: "cs-aero",
        client_name: "Aeromexico",
        industry: "travel",
        hero_metric_en: "12pt NPS lift",
        hero_metric_es: "12pt aumento NPS",
        result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 0.6, tier: "enterprise" as const,
      },
    ],
    notable_clients: [],
    sender: {
      full_name: "Pedro De Velasco",
      tenant_display_name: "Runna CA",
    },
    deep_pitch_url: null,
    ...over,
  };
}

// ── Returns null when no case studies ──────────────────────────────────────

test("composePitchHeuristic: produces no-case pitch when no case studies exist", () => {
  // Pre-2026-04-27 this returned null. Now we surface the no-case pitch
  // because the schema allows case_study_id=null and a generic pitch is
  // strictly better than nothing — caller can still decide to discard it.
  const r = composePitchHeuristic(fullInputs({ case_studies: [] }));
  assert.ok(r);
  assert.equal(r!.case_study_id, null);
  assert.match(r!.body, /We've solved this for brands like yours/);
});

test("composePitchHeuristic: case_study_id=null when no case fits (strength<0.4)", () => {
  const r = composePitchHeuristic(
    fullInputs({
      case_studies: [
        {
          id: "cs-weak",
          client_name: "Weak Match",
          industry: "DTC marketplace",
          hero_metric_en: "+10%",
          hero_metric_es: null,
          result_description_en: null,
          result_description_es: null,
          testimonial_quote_en: null,
          testimonial_quote_es: null,
          measurable_results: [],
          pain_strength: 0.2,
          tier: "smb" as const,
        },
      ],
    }),
  )!;
  assert.equal(r.case_study_id, null);
  assert.doesNotMatch(r.body, /Weak Match/);
  assert.match(r.body, /We've solved this for brands like yours/);
});

test("composePitchHeuristic: case_study_id=null when no case is tagged for the pain", () => {
  const r = composePitchHeuristic(
    fullInputs({
      case_studies: [
        {
          id: "cs-untagged",
          client_name: "Untagged",
          industry: "DTC coffee",
          hero_metric_en: "+50%",
          hero_metric_es: null,
          result_description_en: null,
          result_description_es: null,
          testimonial_quote_en: null,
          testimonial_quote_es: null,
          measurable_results: [],
          pain_strength: null,
          tier: "smb" as const,
        },
      ],
    }),
  )!;
  assert.equal(r.case_study_id, null);
  assert.doesNotMatch(r.body, /Untagged/);
});

// ── Subject + body shape ────────────────────────────────────────────────────

test("composePitchHeuristic: produces subject + body in English", () => {
  const r = composePitchHeuristic(fullInputs())!;
  // Evidence present → subject uses "Checked [company]: noticed something" pattern
  assert.match(r.subject, /Calgary Coffee Roasters/);
  assert.match(r.subject, /noticed something/i);
  // preview_text should contain the observation
  assert.ok(r.preview_text.length > 0);
  assert.match(r.body, /^Hi Sarah,/);
  assert.match(r.body, /mobile checkout takes 3 screens/);
  assert.match(r.body, /DiDi/);
  assert.match(r.body, /\+47% mobile checkout/);
  assert.match(r.body, /no call, no commitment/i);
  assert.match(r.body, /— Pedro/);
  assert.match(r.body, /Runna/);
});

test("composePitchHeuristic: switches to Spanish when prospect.language='es'", () => {
  const r = composePitchHeuristic(
    fullInputs({
      prospect: {
        id: "p2",
        company_name: "Café CDMX",
        industry: "DTC coffee",
        language: "es",
        employee_size_estimate: null,
        city: null,
        market: null,
        what_they_do: null,
        tech_stack: [],
      },
    }),
  )!;
  // Evidence present → ES subject uses "Revisé [company] — encontré algo" pattern
  assert.match(r.subject, /Café CDMX/);
  assert.match(r.subject, /revis|encontr/i);
  assert.match(r.body, /^Hola Sarah,/);
  assert.match(r.body, /\+47% checkout móvil/);
  assert.match(r.body, /5 min/);
});

// ── Case study selection: industry match wins ──────────────────────────────

test("composePitchHeuristic: prefers industry-match case study over higher-strength non-match", () => {
  const r = composePitchHeuristic(
    fullInputs({
      case_studies: [
        {
          id: "cs-coffee",
          client_name: "Toronto Roasters",
          industry: "DTC coffee",
          hero_metric_en: "+30% subscription retention",
          hero_metric_es: null,
          result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 0.5, tier: "smb" as const,
        },
        {
          id: "cs-misc",
          client_name: "DiDi",
          industry: "marketplace",
          hero_metric_en: "+47% checkout",
          hero_metric_es: null,
          result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 0.95, tier: "smb" as const,
        },
      ],
    }),
  )!;
  assert.equal(r.case_study_id, "cs-coffee");
  assert.match(r.body, /Toronto Roasters/);
});

test("composePitchHeuristic: falls back to highest-strength when no industry match", () => {
  const r = composePitchHeuristic(
    fullInputs({
      prospect: {
        id: "p3",
        company_name: "Some Brand",
        industry: "industrial supplies",
        language: "en",
        employee_size_estimate: null,
        city: null,
        market: null,
        what_they_do: null,
        tech_stack: [],
      },
      case_studies: [
        {
          id: "cs-low",
          client_name: "Low Match",
          industry: "marketing",
          hero_metric_en: "+10%",
          hero_metric_es: null,
          result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 0.3, tier: "smb" as const,
        },
        {
          id: "cs-high",
          client_name: "High Strength",
          industry: "tech",
          hero_metric_en: "+99%",
          hero_metric_es: null,
          result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 0.85, tier: "smb" as const,
        },
      ],
    }),
  )!;
  assert.equal(r.case_study_id, "cs-high");
});

// ── Contact selection: prefers non-role-based ──────────────────────────────

test("composePitchHeuristic: prefers non-role-based contact when both exist", () => {
  const r = composePitchHeuristic(
    fullInputs({
      // Contacts arrive ordered by priority_rank (both pitch call sites use
      // .order("priority_rank")). A personal address is inserted at rank 1-2 and
      // a role inbox at rank 5, so the human ALWAYS comes first in reality.
      contacts: [
        { full_name: "Maria", email: "maria@x.example", email_is_role_based: false, role_title: null },
        { full_name: null, email: "info@x.example", email_is_role_based: true, role_title: null },
      ],
    }),
  )!;
  assert.match(r.body, /^Hi Maria,/);
  assert.equal(r.contact_used, "maria@x.example");
});

test("composePitchHeuristic: greets the contact the email is SENT to", () => {
  // Regression for the Waghorn Stephens bug: the pitch went to
  // john.sipos@waglaw.net but opened "Hi Mark," because the composer preferred
  // "any non-role contact that has a full_name" while the send path resolves the
  // top-ranked usable contact. Both must resolve to the SAME person.
  const r = composePitchHeuristic(
    fullInputs({
      contacts: [
        { full_name: null, email: "john.sipos@waglaw.net", email_is_role_based: false, role_title: null },
        { full_name: "Mark Jones", email: "mark@waglaw.net", email_is_role_based: false, role_title: null },
      ],
    }),
  )!;
  assert.equal(r.contact_used, "john.sipos@waglaw.net");
  assert.doesNotMatch(r.body, /Hi Mark/);
});

test("composePitchHeuristic: falls back to 'there' when only role-based contacts exist", () => {
  const r = composePitchHeuristic(
    fullInputs({
      contacts: [
        { full_name: null, email: "info@x.example", email_is_role_based: true, role_title: null },
      ],
    }),
  )!;
  assert.match(r.body, /^Hi there,/);
});

test("composePitchHeuristic: 'there' when no contacts at all", () => {
  const r = composePitchHeuristic(fullInputs({ contacts: [] }))!;
  assert.match(r.body, /^Hi there,/);
  assert.equal(r.contact_used, null);
});

// ── Pain selection ─────────────────────────────────────────────────────────

test("composePitchHeuristic: prefers pain WITH evidence over pain without", () => {
  const r = composePitchHeuristic(
    fullInputs({
      pains: [
        { pain_id: "pain-a", pain_label: "Brand inconsistency", evidence_quote: null },
        {
          pain_id: "pain-b",
          pain_label: "Slow site",
          evidence_quote: "checkout takes 8 seconds on 4G",
        },
      ],
    }),
  )!;
  assert.equal(r.pain_id, "pain-b");
  assert.match(r.body, /checkout takes 8 seconds/);
});

test("composePitchHeuristic: trims evidence quote to 120 chars", () => {
  const longQuote =
    "this is an extremely long quote that goes on and on and on past the 120 character limit which means we need to trim it so the email body stays scannable and readable for the prospect";
  const r = composePitchHeuristic(
    fullInputs({
      pains: [
        { pain_id: "pain-z", pain_label: "Too verbose", evidence_quote: longQuote },
      ],
    }),
  )!;
  // The trimQuote function caps at 120 chars + "...". The evidence appears
  // inline after "— " in the opening hook, not in quotes. Verify the body
  // contains "..." (truncation happened) and does NOT contain the full quote.
  assert.match(r.body, /\.\.\./);
  assert.doesNotMatch(r.body, /readable for the prospect/);
});

// ── Quality self-score ─────────────────────────────────────────────────────

test("composePitchHeuristic: full inputs score ≥ 0.8", () => {
  const r = composePitchHeuristic(fullInputs())!;
  assert.ok(r.quality_self_score >= 0.8, `expected ≥0.8, got ${r.quality_self_score}`);
});

test("composePitchHeuristic: missing evidence + missing contact tank the score", () => {
  const r = composePitchHeuristic(
    fullInputs({
      pains: [{ pain_id: "p", pain_label: "X", evidence_quote: null }],
      contacts: [],
    }),
  )!;
  assert.ok(r.quality_self_score <= 0.45, `expected ≤0.45, got ${r.quality_self_score}`);
});

// ── Deep pitch link ────────────────────────────────────────────────────────

test("composePitchHeuristic: appends deep pitch link when provided", () => {
  const r = composePitchHeuristic(
    fullInputs({ deep_pitch_url: "https://runna.example/pitch/abc" }),
  )!;
  assert.match(r.body, /More context if useful: https:\/\/runna\.example\/pitch\/abc/);
});

test("composePitchHeuristic: omits deep pitch line when null", () => {
  const r = composePitchHeuristic(fullInputs({ deep_pitch_url: null }))!;
  assert.doesNotMatch(r.body, /More context if useful/);
});

// ── Determinism ────────────────────────────────────────────────────────────

test("composePitchHeuristic: deterministic — same inputs produce same output", () => {
  const a = composePitchHeuristic(fullInputs())!;
  const b = composePitchHeuristic(fullInputs())!;
  assert.deepEqual(a, b);
});

// ── Word count target (~140) ───────────────────────────────────────────────

test("composePitchHeuristic: body stays under 200 words", () => {
  const r = composePitchHeuristic(fullInputs())!;
  const words = r.body.trim().split(/\s+/).length;
  assert.ok(words < 200, `expected <200 words, got ${words}`);
});
