/**
 * The no-website pitch (lib/pitches/website-pitch-copy.ts), proven facts
 * 2026-11-09: v1 told every such prospect "I work with [industry] businesses
 * across Canada", "most of the business owners I talk to … tell me…",
 * offered "examples from [industry] businesses we've built for" and asked
 * whether having no website was "a deliberate choice". v2 said what we build,
 * and about them only that their Google listing shows no website. v3 drops
 * that too (discovery can miss a website for many reasons): about them only
 * their name and industry.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findAbsenceClaims, findTrackRecordClaims } from "../lib/pitches/content-rules.ts";
import { evaluateSendGate } from "../lib/pitches/send-gate.ts";
import { senderSignature } from "../lib/pitches/sender-identity.ts";
import {
  WEBSITE_PROMPT_VERSION,
  websiteCaseStudyLine,
  websiteFallbackPitch,
  websitePitchPrompt,
  type WebsiteCopyInput,
} from "../lib/pitches/website-pitch-copy.ts";

const input = (language: "en" | "es", over: Partial<WebsiteCopyInput> = {}): WebsiteCopyInput => ({
  companyName: "Sonrisa Dental",
  industry: language === "es" ? "consultorios dentales" : "dental clinic",
  language,
  firstName: null,
  caseStudyLine: null,
  signature: senderSignature(language),
  ...over,
});

const V1_CLAIMS = [
  /I work with/i, /talk to/i, /deliberate/i, /built for/i, /all the time/i, /like yours/i,
  /Trabajo con/i, /con los que hablo/i, /que hemos construido/i, /decisión deliberada/i, /seguido para/i,
];

// Anything about their website, listing or online presence: these emails hold none of it.
const ABOUT_THEIR_SITE = [
  /listing/i, /ficha/i, /\bno website\b/i, /without a website/i, /doesn'?t (?:show|have)/i, /don'?t have/i,
  /no muestra/i, /no tiene/i, /sin (?:un )?sitio/i, /your (?:site|website|online)/i, /(?:su|tu) (?:sitio|p[áa]gina)/i,
  /presencia/i, /online presence/i, /seguidores/i, /your followers/i,
];

const variants = () =>
  (["en", "es"] as const).flatMap((lang) =>
    [{}, { firstName: "Ana" }, { caseStudyLine: websiteCaseStudyLine(lang) }].map((over) => ({ lang, over, ...websiteFallbackPitch(input(lang, over)) })),
  );

test("fallback templates: no claim about who we work with, talk to or built for, and no absence", () => {
  for (const { lang, over, subject, body } of variants()) {
    const label = `${lang} ${JSON.stringify(over)}`;
    assert.deepEqual(findTrackRecordClaims(`${subject}\n${body}`), [], label);
    assert.deepEqual(findAbsenceClaims(`${subject}\n${body}`), [], label);
    for (const re of V1_CLAIMS) assert.doesNotMatch(body, re, `${label}: ${re}`);
    assert.ok(body.includes(lang === "es" ? "Quise compartirles una idea para Sonrisa Dental." : "I wanted to share a quick idea for Sonrisa Dental."), label);
    assert.ok(body.endsWith(senderSignature(lang)), label);
  }
});

test("fallback templates pass the send gate's claim and number checks", () => {
  for (const { lang, over, subject, body } of variants()) {
    const r = evaluateSendGate({
      subject, body, lang,
      recipientEmail: "ana.ruiz@sonrisadental.mx", recipientFullName: over.firstName ? "Ana Ruiz" : null, recipientSelectedBy: null,
      checkRecipientSource: false, companyName: "Sonrisa Dental", siteName: null, domain: null, websiteVerified: false,
      evidenceQuotes: [], benchmarkFigures: [], clientNames: [],
    });
    const codes = r.pass ? [] : r.failures.map((f) => f.code);
    for (const code of ["absence_claim", "track_record_claim", "unsourced_metric", "banned_jargon", "em_dash"]) {
      assert.ok(!codes.includes(code as never), `${lang} ${JSON.stringify(over)}: ${code} in ${JSON.stringify(r)}`);
    }
  }
});

test("the case-study line says what the work is, never who it was for or how often", () => {
  for (const lang of ["en", "es"] as const) {
    const line = websiteCaseStudyLine(lang);
    assert.deepEqual(findTrackRecordClaims(line), []);
    assert.doesNotMatch(line, /all the time|like yours|seguido|para negocios de/i);
  }
});

test("no template, structure or prompt line says anything about their listing, website or online presence", () => {
  for (const { lang, over, subject, body } of variants()) {
    for (const re of ABOUT_THEIR_SITE) assert.doesNotMatch(`${subject}\n${body}`, re, `${lang} ${JSON.stringify(over)}: ${re}`);
  }
  for (const lang of ["en", "es"] as const) {
    const prompt = websitePitchPrompt({ ...input(lang), market: lang === "es" ? "MX" : "CA" });
    const structure = prompt.slice(prompt.indexOf("Subject:"), prompt.indexOf("\nRules:"));
    for (const re of ABOUT_THEIR_SITE) assert.doesNotMatch(structure, re, `${lang} structure: ${re}`);
    // Outside the structure, their website or listing comes up only in a line that forbids saying anything about it.
    const outside = prompt.replace(structure, "").split("\n");
    const mentions = outside.filter((l) => /listing|ficha|online presence|their website|whether they have/i.test(l));
    assert.equal(mentions.length, 1, `${lang}: ${JSON.stringify(mentions)}`);
    assert.match(mentions[0] ?? "", /^- Never say or guess anything about their website, Google listing, online presence or social media/);
    assert.doesNotMatch(prompt, /shows no website|doesn't show a website|no muestra un sitio/i, lang);
    assert.ok(prompt.includes("say only its name and that it is a"), lang);
  }
});

test("the Claude prompt: its structure claims nothing; its rules forbid a track record, a conversation and any absence", () => {
  assert.equal(WEBSITE_PROMPT_VERSION, "website-v3-2026-11-09");
  for (const lang of ["en", "es"] as const) {
    const prompt = websitePitchPrompt({ ...input(lang), market: lang === "es" ? "MX" : "CA" });
    const structure = prompt.slice(prompt.indexOf("Subject:"), prompt.indexOf("\nRules:"));
    assert.deepEqual(findTrackRecordClaims(structure), [], lang);
    assert.deepEqual(findAbsenceClaims(structure), [], lang);
    for (const re of V1_CLAIMS) assert.doesNotMatch(structure, re, `${lang}: ${re}`);
    assert.ok(prompt.includes("Never ask whether any of it is a choice."), lang);
    assert.ok(prompt.includes("Never say who we work with, have worked with, built for or talk to, and never what other owners say or tell us"), lang);
    assert.ok(prompt.includes(lang === "es" ? "Write the email in Spanish." : "Write the email in English."), lang);
  }
});

test("the v1 wording is held by the gate patterns (so a model that drifts back is caught)", () => {
  for (const s of [
    "I work with dental clinic businesses across Canada helping them show up online.",
    "most of the business owners I talk to in dental tell me the same thing",
    "Happy to show you an example or two from dental businesses we've built for.",
    "We do this all the time for dentists like yours.",
    "Trabajo con negocios de consultorios dentales ayudándoles a tener presencia en internet.",
    "la mayoría de los dueños con los que hablo en consultorios dentales me dicen lo mismo",
  ]) assert.notDeepEqual(findTrackRecordClaims(s), [], s);
});

test("stage source: the website stage writes with this module and stores a send-gate verdict", () => {
  const src = readFileSync(new URL("../lib/pitches/website-pitch-stage.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");
  assert.match(code, /const prompt = websitePitchPrompt\(opts\);/);
  assert.equal(code.match(/websiteFallbackPitch\(/g)?.length, 2);
  assert.match(code, /caseStudyLine = websiteCaseStudyLine\(prospect\.language\);/);
  assert.match(code, /prompt_version: WEBSITE_PROMPT_VERSION,/);
  assert.match(code, /await refreshGateAfterChange\(supabase, user\.tenantId, created\.id\)/);
  for (const re of [/I work with/, /talk to/, /deliberate choice/, /Trabajo con/, /all the time/]) assert.doesNotMatch(code, re);
});
