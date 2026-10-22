import assert from "node:assert/strict";
import test from "node:test";
import {
  SENDER_IDENTITY_DEFAULTS,
  reconcileSignOff,
  senderForGenerator,
  senderIdentity,
  senderSignature,
} from "../lib/pitches/sender-identity.ts";
import { buildFollowup1, buildFollowup2, type FollowupContext } from "../lib/pitches/followup-templates.ts";
import { renderIndustryTemplate } from "../lib/pitches/industry-templates.ts";
import { composePitchHeuristic, type GeneratorInputs } from "../lib/pitches/generator.ts";

const ENV_KEYS = ["RUNNA_SENDER_NAME_EN", "RUNNA_SENDER_NAME_ES", "RUNNA_AGENCY_NAME"] as const;

function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, vars);
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── senderIdentity ────────────────────────────────────────────────────────────

test("senderIdentity: Spanish is Nils, English is Henry, both Runna Advertising", () => {
  withEnv({}, () => {
    assert.deepEqual(senderIdentity("es"), {
      firstName: "Nils",
      agency: "Runna Advertising",
      displayName: "Nils · Runna Advertising",
    });
    assert.deepEqual(senderIdentity("en"), {
      firstName: "Henry",
      agency: "Runna Advertising",
      displayName: "Henry · Runna Advertising",
    });
    assert.equal(SENDER_IDENTITY_DEFAULTS.agency, "Runna Advertising");
  });
});

test("senderIdentity: anything that isn't Spanish gets the English sender", () => {
  withEnv({}, () => {
    for (const lang of [null, undefined, "", "fr", "EN"]) {
      assert.equal(senderIdentity(lang).firstName, "Henry", String(lang));
    }
  });
});

test("senderIdentity: env overrides win, blank overrides fall back", () => {
  withEnv({ RUNNA_SENDER_NAME_ES: "Lucía", RUNNA_SENDER_NAME_EN: "  Sam  ", RUNNA_AGENCY_NAME: "Rünna" }, () => {
    assert.equal(senderIdentity("es").displayName, "Lucía · Rünna");
    assert.equal(senderIdentity("en").firstName, "Sam");
  });
  withEnv({ RUNNA_SENDER_NAME_ES: "   ", RUNNA_AGENCY_NAME: "" }, () => {
    assert.equal(senderIdentity("es").displayName, "Nils · Runna Advertising");
  });
});

test("senderSignature / senderForGenerator: name line then agency line", () => {
  withEnv({}, () => {
    assert.equal(senderSignature("es"), "Nils\nRunna Advertising");
    assert.equal(senderSignature("en"), "Henry\nRunna Advertising");
    assert.deepEqual(senderForGenerator("es"), { full_name: "Nils", tenant_display_name: "Runna Advertising" });
  });
});

// ── Follow-up templates ─────────────────────────────────────────────────────

function followupCtx(over: Partial<FollowupContext> = {}): FollowupContext {
  return {
    prospectName: "Tienda Norte",
    contactName: null,
    originalSubject: "una idea para Tienda Norte",
    painLabel: null,
    lang: "es",
    signature: "Nils\nRunna Advertising",
    hunterUrl: "https://spam-runnareach.vercel.app/r/abcdefgh?market=mx&s=1",
    ...over,
  };
}

test("follow-up templates: Spanish prospects get Spanish, signed by the sender", () => {
  for (const build of [buildFollowup1, buildFollowup2]) {
    const email = build(followupCtx());
    assert.equal(email.subject, "Re: una idea para Tienda Norte");
    assert.match(email.body, /^Hola, equipo de Tienda Norte,/);
    assert.ok(email.body.endsWith("\n\nNils\nRunna Advertising"), email.body);
    assert.doesNotMatch(email.body, /Pedro|—|\bHi\b/);
  }
});

test("follow-up templates: English, named contact, pain label", () => {
  const ctx = followupCtx({
    lang: "en",
    contactName: "Sarah",
    painLabel: "online booking",
    prospectName: "Calgary Coffee",
    originalSubject: "Re: quick idea",
    signature: "Henry\nRunna Advertising",
  });
  const one = buildFollowup1(ctx);
  assert.equal(one.subject, "Re: quick idea");
  assert.match(one.body, /^Hi Sarah,/);
  assert.match(one.body, /online booking at Calgary Coffee/);
  const two = buildFollowup2(ctx);
  assert.match(two.body, /Last note/);
  for (const e of [one, two]) {
    assert.ok(e.body.endsWith("\n\nHenry\nRunna Advertising"));
    assert.doesNotMatch(e.body, /Pedro|—/);
  }
});

// ── Pitch fallbacks ───────────────────────────────────────────────────────────

function inputs(lang: "en" | "es"): GeneratorInputs {
  return {
    prospect: {
      id: "p1",
      company_name: lang === "es" ? "Café Tacuba" : "Calgary Coffee Roasters",
      industry: "restaurant",
      language: lang,
      employee_size_estimate: null,
      city: null,
      market: null,
      what_they_do: null,
      tech_stack: [],
    },
    pains: [],
    contacts: [],
    case_studies: [],
    notable_clients: [],
    benchmarks: [],
    sender: senderForGenerator(lang),
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=mx",
  };
}

test("industry templates: signed Nils (ES) / Henry (EN) under Runna Advertising, never Pedro", () => {
  withEnv({}, () => {
    const es = renderIndustryTemplate(inputs("es"), "test");
    assert.ok(es.body.endsWith("\n\nNils\nRunna Advertising"), es.body.slice(-80));
    const en = renderIndustryTemplate(inputs("en"), "test");
    assert.ok(en.body.endsWith("\n\nHenry\nRunna Advertising"), en.body.slice(-80));
    for (const p of [es, en]) {
      assert.doesNotMatch(p.body, /Pedro|\{\w+\}/);
    }
  });
});

test("heuristic generator: falls back to the per-language sender when no name is given", () => {
  withEnv({}, () => {
    const base = inputs("es");
    const r = composePitchHeuristic({ ...base, sender: { full_name: null, tenant_display_name: "" } });
    assert.ok(r);
    assert.match(r!.body, /Nils\nRunna Advertising/);
    assert.doesNotMatch(r!.body, /Pedro/);
  });
});

// ── reconcileSignOff ─────────────────────────────────────────────────────────

test("reconcileSignOff: swaps every legacy Pedro sign-off for the current sender", () => {
  withEnv({}, () => {
    const head = "Hi Sam,\n\nShort note.\n\n👉 See it: https://x.example";
    for (const legacy of [
      "Pedro\nRunna",
      "Pedro\nRünna",
      "Pedro De Velasco\nRunna CA",
      "— Pedro",
      "Pedro",
      "Pedro\nRünna Advertising\nrunna.agency",
      "Pedro\nRunna  \n\n",
    ]) {
      assert.equal(reconcileSignOff(`${head}\n\n${legacy}`, "en"), `${head}\n\nHenry\nRunna Advertising`, legacy);
    }
    assert.equal(reconcileSignOff(`Hola,\n\nTexto.\n\nPedro\nRünna`, "es"), "Hola,\n\nTexto.\n\nNils\nRunna Advertising");
  });
});

test("reconcileSignOff: leaves current sign-offs and mid-body mentions alone", () => {
  withEnv({}, () => {
    const current = "Hi Sam,\n\nNote.\n\nHenry\nRunna Advertising";
    assert.equal(reconcileSignOff(current, "en"), current);
    const mention = "Hi Sam,\n\nPedro\nRunna mentioned you last week.\n\nHenry\nRunna Advertising";
    assert.equal(reconcileSignOff(mention, "en"), mention);
    const name = "Hola,\n\nGracias, Pedro te contactará.\n\nNils\nRunna Advertising";
    assert.equal(reconcileSignOff(name, "es"), name);
  });
});
