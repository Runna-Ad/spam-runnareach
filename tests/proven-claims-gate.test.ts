/**
 * The send gate holds claims we can't prove (2026-11-09): an absence ("I
 * didn't see…") and a track record ("we work with fitness studios"). The
 * body is the email CrushCamp received on 2026-11-09 and answered with a hard
 * no (pitch 7bdf226f, our own text).
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { findAbsenceClaims, findTrackRecordClaims } from "../lib/pitches/content-rules.ts";
import { evaluateSendGate, GATE_SEVERITY, type GateInput } from "../lib/pitches/send-gate.ts";
import { WRITER_FIXABLE } from "../lib/pitches/review.ts";
import { buildFollowup2 } from "../lib/pitches/followup-templates.ts";
import { senderSignature } from "../lib/pitches/sender-identity.ts";
import type * as GateModule from "../lib/pitches/gate.ts";

// lib/pitches/gate.ts (the send gate's database side) loads with its real
// send-gate, email-utils and proven-facts; only the audit writer is stubbed.
const at = (p: string) => new URL(p, import.meta.url).href;
const GATE = at("../lib/pitches/gate.ts");
const GATE_REAL = {
  "@/lib/research/email-utils": at("../lib/research/email-utils.ts"),
  "./send-gate": at("../lib/pitches/send-gate.ts"),
  "./proven-facts": at("../lib/pitches/proven-facts.ts"),
};
register("data:text/javascript," + encodeURIComponent(`
const GATE = ${JSON.stringify(GATE)};
const REAL = ${JSON.stringify(GATE_REAL)};
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL === GATE) {
    if (REAL[spec]) return { url: REAL[spec], shortCircuit: true };
    if (spec === "@/lib/audit/log") return { url: "stub:audit", shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url === "stub:audit") return { format: "module", source: "export const writeAuditLog = async () => undefined;", shortCircuit: true };
  return next(url, ctx);
}`));

const CRUSHCAMP_BODY = `Hi Sweat,

Henry from Runna Advertising here. We work with independent fitness studios on exactly this.

I didn't see the viewport setting on your home page that makes a page fit a phone screen. For most fitness studios, people checking schedules or memberships on their phone don't come back if the page doesn't load right.

We'd build you a site that works on any screen, with your booking flow and shop laid out so someone can sign up for a trial or buy a pass on the first try. Fast, easy to book from, built to bring people in.

We do this kind of work for boutique fitness studios: finding where people slip away, then making sure more of the visitors you already have actually book.

👉 Don't take my word for it, take the data's: see what our free check finds on your site. About 30 seconds, no signup, no strings: https://runna-check.vercel.app/r/4gbwrcfc?market=ca&industry=fitness. See something worth fixing? Reply. If not, no harm done.

Henry
Runna Advertising`;

function input(body: string, over: Partial<GateInput> = {}): GateInput {
  return {
    subject: "mobile fitness bookings",
    body,
    lang: "en",
    recipientEmail: "sweat@crushcamp.com",
    recipientFullName: null,
    recipientSelectedBy: null,
    checkRecipientSource: false,
    companyName: "CrushCamp",
    siteName: null,
    domain: "crushcamp.com",
    websiteVerified: true,
    evidenceQuotes: [],
    benchmarkFigures: [],
    clientNames: [],
    ...over,
  };
}

const codes = (i: GateInput) => {
  const r = evaluateSendGate(i);
  return r.pass ? [] : r.failures.map((f) => f.code);
};

test("CrushCamp's email: both new codes hold it, and its greeting is not a name", () => {
  const c = codes(input(CRUSHCAMP_BODY));
  assert.ok(c.includes("absence_claim"), JSON.stringify(c));
  assert.ok(c.includes("track_record_claim"), JSON.stringify(c));
  assert.ok(c.includes("greeting_not_a_name"), JSON.stringify(c));
  assert.equal(GATE_SEVERITY.absence_claim, "block");
  assert.equal(GATE_SEVERITY.track_record_claim, "block");
  assert.ok(WRITER_FIXABLE.has("absence_claim") && WRITER_FIXABLE.has("track_record_claim"), "the writer rewrites them");
});

test("absence wording, English and Spanish, is found", () => {
  for (const s of [
    "I didn't see a way to book online on your site.",
    "I couldn't find your hours.",
    "There's no way to book after six.",
    "You don't have a contact form.",
    "Your website doesn't show prices.",
    "No vi forma de agendar en línea.",
    "No encontré sus horarios.",
    "No hay manera de reservar.",
    "Tu sitio no muestra precios.",
    "Se quedan sin forma de pagar.",
    // Added 2026-11-09 (review of the first cut).
    "You have no online booking.",
    "There isn't a way to book after six.",
    "There is not an option to pay online.",
    "There aren't any forms to fill in.",
    "There are not links to the menu.",
    "No pude encontrar sus horarios.",
    "No pude ver los precios.",
    "No se ve el horario en el sitio.",
    "No cuentan con reservaciones en línea.",
  ]) assert.ok(findAbsenceClaims(s).length > 0, s);
});

test("curly apostrophes are the same words: every curly absence and track-record line is found", () => {
  for (const s of ["I didn’t see a way to book online.", "I couldn’t find your hours.", "There’s no way to book after six.", "You don’t have a contact form.", "Your site doesn’t show prices."]) {
    assert.ok(findAbsenceClaims(s).length > 0, s);
  }
  for (const s of ["We’ve worked with clinics like yours.", "We’ve helped studios like yours."]) assert.ok(findTrackRecordClaims(s).length > 0, s);
  // The gate holds the curly version of CrushCamp's line too.
  assert.ok(codes(input(CRUSHCAMP_BODY.replace(/'/g, "’"))).includes("absence_claim"));
});

test("track-record wording, English and Spanish, is found", () => {
  for (const s of [
    "We work with independent fitness studios on exactly this.",
    "We've worked with clinics like yours.",
    "We do this kind of work for boutique studios.",
    "Our clients include three dental groups.",
    "Trabajamos con negocios de tu industria.",
    "Hemos trabajado con despachos como el suyo.",
    "Hacemos este tipo de trabajo para clínicas.",
    // "We work with" + a kind of business within five words, or "like you/yours".
    "We have worked with a few local dental clinics.",
    "We work with a team like yours.",
    "We've helped a lot of owners.",
    // Who we talk to: conversations we can't show. The first is the showcase opener before 2026-11-09.
    "Most [industry] owners we talk to want to use AI but aren't sure where it would actually help.",
    "Most manufacturers we talk to want to use AI.",
    "The managers we speak with say the same.",
    "Clients we work with love it.",
    "La mayoría de los dueños de [industria] con los que hablamos quieren usar IA, pero no saben dónde les ayudaría de verdad.",
    "Los dueños con quienes hablamos lo piden.",
    "Las clínicas con las que trabajamos lo usan.",
    "Trabajamos con clínicas dentales en Puebla.",
  ]) assert.ok(findTrackRecordClaims(s).length > 0, s);
});

test("must not change: offers, capability lines, the CTA and showcase lines pass", () => {
  for (const s of [
    "You have no obligation to reply.",
    "We work with the people on your team to set it up.",
    "We build tools that let a small team do the work of a much bigger one.",
    "We build this kind of thing around how a business already works, so nobody has to change how they do their job.",
    "You don't have to change how you work.",
    "We'd work with your team to set it up.",
    "We work with you to set it up in a week.",
    "For a team that juggles requests from several departments, we built a shared board.",
    "About 30 seconds, no signup, no strings.",
    "There's no catch.",
    "I saw the job post for a second front-desk person.",
    "Trabajamos con usted para dejarlo listo.",
    "Hacemos herramientas para que un equipo pequeño rinda como uno mucho más grande.",
    "No hay problema si no es el momento.",
    // "We work with" + no kind of business: a capability (2026-11-09).
    "We work with what you already use.",
    "We work with Squarespace sites too.",
    "We work with your team to set it up.",
    "We work with any booking system you already use.",
    // The showcase opener since 2026-11-09 (showcase-v2).
    "Small teams get a lot more done when the repetitive work runs on its own.",
    "Un equipo pequeño rinde mucho más cuando el trabajo repetitivo se hace solo.",
  ]) {
    assert.deepEqual(findAbsenceClaims(s), [], s);
    assert.deepEqual(findTrackRecordClaims(s), [], s);
  }
});

// ── Second review (2026-11-09): singular forms, the reviewer's misses, fewer false positives ──

test("track record, second review: singular forms and the reviewer's misses are found", () => {
  for (const s of [
    "I work with dental clinics across Canada.",
    "I've worked with law firms like yours.",
    "I have worked with a few local restaurants.",
    "Most of the business owners I talk to in dental tell me the same thing.",
    "The owners I speak to all say it.",
    "Trabajo con negocios de restaurantes ayudándoles a crecer.",
    "La mayoría de los dueños con los que hablo me dicen lo mismo.",
    "Un par de ejemplos que hemos construido para negocios como el suyo.",
    "We partner with local gyms across Calgary.",
    "We help clinics like yours.",
    "We help small shops like Boutique Sol.",
    "We've built this for other studios.",
    "Other gym owners tell us the same thing.",
    "Ayudamos a negocios como el suyo.",
    "Colaboramos con clínicas dentales en Puebla.",
    "Happy to show you an example or two from dental businesses we've built for.",
    "We do this all the time for dentists like yours.",
    "Esto lo hacemos seguido para negocios de este giro.",
  ]) assert.ok(findTrackRecordClaims(s).length > 0, s);
});

test("absence, second review: the reviewer's misses are found", () => {
  for (const s of [
    "There's no online booking on the site.",
    "Theres no way to pay online.",
    "You're missing online booking.",
    // Their customers only since the third review: "customers can't…" alone is a general point.
    "Your customers can't book after six.",
    "Your clients can't pay online.",
    "Your people can't order from their phone.",
    "Your visitors can't reach anyone after hours.",
    "No tienen reservaciones en línea.",
    "Les falta un sitio web.",
    "No pueden agendar en línea.",
    "No pueden pagar con tarjeta.",
    "No hay reservaciones en línea.",
    "Su sitio no muestra precios.",
  ]) assert.ok(findAbsenceClaims(s).length > 0, s);
});

test("second review: what must pass, including the false positives removed", () => {
  for (const s of [
    // "there's no / you have no" + a word that claims nothing about them.
    "There's no obligation.", "There's no catch.", "There's no cost to run it.", "There's no signup.", "There's no pressure.",
    "There's no need to change anything.", "There's no charge.", "There's no commitment.", "You have no obligation to reply.",
    // General cost sentences say "without a way to".
    "Most people end up going elsewhere without a way to book after hours.",
    // A conditional is no claim about their site.
    "Si su sitio no carga rápido, la gente se va.",
    "No hay compromiso.", "No hay costo.", "No hay registro.", "No hay problema si no es el momento.", "No hay prisa.",
    "No hay que cambiar nada.", "No tienen que cambiar nada.",
    // How we work, not who we work with.
    "We work with small teams so nobody has to change how they work.",
    "We work with the people on your team to set it up.",
    "Trabajamos con equipos pequeños para que nadie cambie su forma de trabajar.",
    "We do it for you, so nobody has to.",
    "We help you get found online.",
  ]) {
    assert.deepEqual(findAbsenceClaims(s), [], s);
    assert.deepEqual(findTrackRecordClaims(s), [], s);
  }
});

// ── The send gate's own context (lib/pitches/gate.ts loadGateContext) ────────

/** Answers each table's read with one row (or a list for contacts); every chain call returns itself. */
function gateDb(rows: Record<string, unknown>) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "in", "is", "not"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(ok);
      return q;
    },
  };
}

test("send gate: a figure only a research pain quote holds is unsourced; what_they_do sources its facts, never its guesses", async () => {
  const { loadGateContext, gateInputFor } = (await import(GATE)) as typeof GateModule;
  const ctx = await loadGateContext(
    gateDb({
      prospects: { company_name: "CrushCamp", domain: "crushcamp.com", language: "en" },
      prospect_research: {
        last_scraped_at: "2026-11-02T00:00:00Z",
        evidence_urls: ["https://www.crushcamp.com/"],
        site_name: null,
        what_they_do: "Boutique fitness studio with 2 locations in Calgary; likely 3 staff",
        pain_points: [{ pain_label: "Low online bookings", evidence_quote: "Only 7 of 10 visitors book a class online" }],
      },
      prospect_contacts: [],
    }),
    "t1",
    "p1",
    { benchmarkSources: [], clientNames: [] },
  );
  assert.ok(ctx);
  assert.deepEqual(ctx.evidenceQuotes, ["Boutique fitness studio with 2 locations in Calgary"]);
  const unsourced = (line: string) => {
    const r = evaluateSendGate(gateInputFor(ctx, {
      subject: "an idea for crushcamp",
      body: `Hi CrushCamp team,\n\nHenry from Runna Advertising here. ${line}\n\n👉 See what our free check finds, about 30 seconds: https://runna-check.vercel.app/r/abc\n\nHenry\nRunna Advertising`,
      recipient: { email: "sweat@crushcamp.com", full_name: null, selected_by: null },
      checkRecipientSource: false,
    }));
    return r.pass ? [] : r.failures.filter((f) => f.code === "unsourced_metric").map((f) => f.detail);
  };
  // Only the research pain quote had "7 of 10": the writer never saw it, so it sources nothing now.
  assert.notDeepEqual(unsourced("About 7 of 10 visitors leave without booking."), []);
  // A fact of what_they_do still sources its number; a guess clause cut from it does not.
  assert.deepEqual(unsourced("Running 2 locations keeps the front desk busy."), []);
  assert.notDeepEqual(unsourced("With 3 staff, the front desk is stretched."), []);
});

test("the breakup template claims no look and no finding, with or without a pain label, and passes the gate's claim checks", () => {
  for (const lang of ["en", "es"] as const) {
    for (const painLabel of [null, "online booking"]) {
      const { body } = buildFollowup2({ prospectName: "CrushCamp", contactName: null, originalSubject: "an idea", painLabel, lang, signature: senderSignature(lang), hunterUrl: "https://runna-check.vercel.app/r/abc" });
      assert.doesNotMatch(body, /looked|found|spotted|revisamos|encontramos|vimos|online booking|hueco|gap/i, `${lang}/${painLabel}`);
      assert.deepEqual(findAbsenceClaims(body), [], `${lang}/${painLabel}`);
      assert.deepEqual(findTrackRecordClaims(body), [], `${lang}/${painLabel}`);
    }
  }
});

// ── Third review (2026-11-09): feature nouns, general "when / if" clauses, "we do this for [businesses]" ──

test("absence, third review: what is said about their site or their customers is found", () => {
  for (const s of [
    // "there's no / no hay / no tienen" + a feature, with an article or "online" in between.
    "There's no easy way to book.",
    "There are no prices listed.",
    "There isn't a booking button.",
    "You have no contact page.",
    "No hay ningún botón para reservar.",
    "No hay en línea una forma de pagar.",
    "No tienen una página de contacto.",
    "Su negocio no tiene página web.",
    // A "when / if" clause that names them is still about them.
    "When your customers can't book online, they leave.",
    "Cuando entré a su sitio no hay forma de reservar.",
    "Si su negocio no cuenta con reservas, se pierden citas.",
    // The comma ends the "if" clause: what follows is a claim.
    "If you look, there's no booking page.",
    // The no-website pitch's v2 line (website-v3 dropped it: discovery can miss a website).
    "Your Google listing doesn't show a website, so I wanted to share a quick idea.",
    "Su ficha de Google no muestra un sitio web, así que quise compartirles una idea.",
  ]) assert.ok(findAbsenceClaims(s, "CrushCamp").length > 0, s);
});

test("absence, third review: the company name stands in for \"your\"", () => {
  const s = "CrushCamp's customers can't pay online.";
  assert.deepEqual(findAbsenceClaims(s), [], "without the name it is anyone's customers");
  assert.notDeepEqual(findAbsenceClaims(s, "CrushCamp"), []);
  assert.notDeepEqual(findAbsenceClaims("Customers at the studio say CrushCamp clients cannot book on weekends.", "CrushCamp"), []);
  // The send gate passes the company name.
  assert.ok(codes(input(s)).includes("absence_claim"));
  assert.ok(!codes(input("Most customers can't wait a week for a reply.")).includes("absence_claim"));
});

test("absence, third review: reassurances and general points pass", () => {
  for (const s of [
    // Reassurances: no feature follows.
    "There's no rush.", "There's no fee.", "There's no sign-up.", "There's no contract.", "There's no setup.", "There's no login.",
    "There's no reason to change tools.", "You have no setup to do.",
    "No hay ningún compromiso.", "No hay nada que instalar.", "No hay contrato.", "No hay cargo.", "No hay necesidad.",
    "No tienen nada que perder.", "Si no tienen tiempo ahora, lo vemos después.", "Muchos consultorios no tienen tiempo para esto.",
    // Customers in general, not theirs.
    "Customers can't book after six at most clinics.",
    // A "when / if / cuando / si / en cuanto" clause: what tends to happen.
    "When customers can't book online after hours, most try somewhere else.",
    "Whenever there's no easy way to book, people call the next place.",
    "If there's no way to book online, people call someone else.",
    "Si un negocio no cuenta con reservas en línea, la gente se va.",
    "Si no hay alguien que conteste, se pierde la llamada.",
    "Cuando no hay forma de reservar, la gente llama a otro.",
    "En cuanto no hay manera de agendar, la gente se va.",
    "Si los clientes no pueden agendar en línea, buscan otra opción.",
  ]) assert.deepEqual(findAbsenceClaims(s, "CrushCamp"), [], s);
});

test("track record, third review: \"we do this for…\" is a claim only when businesses follow", () => {
  for (const s of [
    "We do this for dental clinics.",
    "We do that kind of work for small businesses.",
    "We do it often for people like you.",
    "Lo hacemos para negocios como el suyo.",
    "Hacemos esto para consultorios de la zona.",
    "Hacemos este tipo de trabajo para clínicas como la suya.",
  ]) assert.ok(findTrackRecordClaims(s).length > 0, s);
  for (const s of [
    "We do this for one business at a time.",
    "We do that kind of work for you.",
    "We do that kind of work for you. Most businesses never ask.",
    "Lo hacemos siempre para su negocio.",
    "Hacemos esto para ustedes.",
    "Hacemos este tipo de trabajo para su equipo.",
  ]) assert.deepEqual(findTrackRecordClaims(s), [], s);
});
