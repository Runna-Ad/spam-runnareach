/**
 * Prints real showcase emails for three made-up prospects, so a person can read
 * them before the feature ships. Nothing is saved and nothing is sent: it calls
 * the same writer, AI reviewer and send-gate writing rules the pipeline uses,
 * then prints the result. About 6 to 10 Claude calls (roughly $0.10, not
 * counted toward the app's daily cap).
 *
 * Run from the repo root, with the key from the main checkout's .env.local:
 *   node --env-file=../S.P.A.M/.env.local --experimental-strip-types scripts/showcase-samples.ts
 */

import { composeWithReview, critiquePitch, writingFailures } from "../lib/pitches/review.ts";
import { composeFollowupWithClaude, reviseShowcaseFollowup, type FollowupComposerInput } from "../lib/pitches/followup-composer.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";
import { pickBuilds } from "../lib/runna/builds.ts";

const LINK = "https://runna-hunter.vercel.app/?sample=1";

/** Words from the greeting to the line before the 👉 button (what the length rule counts). */
function wordsBeforeButton(body: string): number {
  return body.split("👉")[0]!.trim().split(/\s+/).filter(Boolean).length;
}

function prospect(p: {
  company: string;
  industry: string;
  lang: "en" | "es";
  city: string;
  market: "CA" | "MX";
  what: string;
  employees: number | null;
  contact: { name: string | null; email: string };
}): GeneratorInputs {
  return {
    prospect: {
      id: "sample",
      company_name: p.company,
      industry: p.industry,
      language: p.lang,
      employee_size_estimate: p.employees,
      city: p.city,
      market: p.market,
      what_they_do: p.what,
      tech_stack: [],
    },
    pains: [],
    contacts: [{ full_name: p.contact.name, email: p.contact.email, email_is_role_based: !p.contact.name, role_title: null }],
    case_studies: [],
    notable_clients: [],
    benchmarks: [],
    sender: { full_name: p.lang === "es" ? "Nils" : "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: LINK,
    showcase_builds: pickBuilds({ industry: p.industry, what_they_do: p.what, lang: p.lang }),
  };
}

async function firstEmail(label: string, input: GeneratorInputs) {
  console.log(`\n━━━ ${label} (showcase as the FIRST email) ━━━`);
  console.log(`builds offered: ${(input.showcase_builds ?? []).map((b) => b.id).join(", ")}`);
  const started = Date.now();
  const r = await composeWithReview(input, { deadline: started + 48_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!r.ok) {
    console.log(`FAILED: ${r.reason}: ${r.error}`);
    return;
  }
  console.log(`subject: ${r.composed.subject}\npreview: ${r.composed.preview_text}\n\n${r.composed.body}\n`);
  console.log(`words before the button: ${wordsBeforeButton(r.composed.body)} (target 80 to 120)`);
  console.log(`builds used: ${(r.composed.builds_used ?? []).join(", ") || "(none reported)"}`);
  console.log(`calls: ${r.calls.map((c) => c.kind).join(", ")} in ${seconds}s (the pipeline allows 48s)`);
  console.log(`AI reviewer: ${r.critic ? `${r.critic.pass ? "pass" : "HELD"} (${r.critic.score}), ${r.critic.revisions} rewrite(s)` : "did not run"}`);
  for (const i of r.critic?.issues ?? []) console.log(`  - ${i}`);
  if (r.critic && r.critic.score < 0.8) console.log("  below 0.8: autopilot would hold it for one rewrite, not send it automatically");
  for (const e of r.criticErrors) console.log(`  reviewer call failed: ${e}`);
  if (!r.critic) {
    // Why not: run the same reviewer once more on its own and print what it says.
    const again = await critiquePitch(input, r.composed, 15_000);
    console.log(`  reviewer on its own: ${again.ok ? `${again.verdict.pass ? "pass" : "HELD"} (${again.verdict.score})` : `failed: ${again.reason}`}`);
    if (again.ok) for (const i of again.verdict.issues) console.log(`    - ${i}`);
  }
  const gate = writingFailures(input, r.composed);
  console.log(`send gate (writing rules): ${gate.length ? gate.map((f) => `${f.code}: ${f.detail}`).join(" | ") : "pass"}`);
}

async function showcaseFollowup(label: string, input: GeneratorInputs) {
  console.log(`\n━━━ ${label} (showcase as FOLLOW-UP #1, after today's first email) ━━━`);
  const p = input.prospect;
  const fu: FollowupComposerInput = {
    step: 2,
    companyName: p.company_name,
    contactFirstName: input.contacts[0]?.full_name?.split(" ")[0] ?? null,
    language: p.language,
    market: p.market === "MX" ? "MX" : "CA",
    industry: p.industry ?? null,
    city: p.city ?? null,
    originalSubject: "no way to book online at " + p.company_name.toLowerCase(),
    originalBody: `Hi,\n\nChecked ${p.company_name}'s site: the only way to book is to call during office hours.\n\n👉 ${LINK}\n\nHenry\nRunna Advertising`,
    painSummary: null,
    evidenceQuote: null,
    whatTheyDo: p.what_they_do ?? null,
    techStack: [],
    hunterValue: null,
    senderFirstName: "Henry",
    agencyName: "Runna Advertising",
    hunterUrl: LINK,
    mode: "showcase",
    builds: input.showcase_builds ?? [],
  };
  const started = Date.now();
  const r = await composeFollowupWithClaude(fu);
  if (!r.ok) {
    console.log(`FAILED: ${r.reason}: ${r.error}`);
    return;
  }
  // What production runs before this follow-up may send: the writing rules
  // (here the first email's, production uses the full send gate), the
  // reviewer, and one rewrite with their reasons when either holds it.
  const contact = input.contacts[0]!;
  const checked = await reviseShowcaseFollowup(
    fu,
    r.followup,
    { email: contact.email ?? "", full_name: contact.full_name, role_based: contact.email_is_role_based },
    { deadline: started + 70_000, writingFailures: (f) => writingFailures(input, f).map((x) => `${x.code}: ${x.detail}`) },
  );
  const final = checked.ok ? checked.followup : r.followup;
  if (!checked.ok || checked.revisions > 0) {
    console.log(`first draft (${wordsBeforeButton(r.followup.body)} words before the button):\n${r.followup.body}\n`);
  }
  if (checked.ok && checked.revisions > 0) console.log("after one rewrite:");
  console.log(`subject: ${final.subject}\n\n${final.body}\n`);
  console.log(`words before the button: ${wordsBeforeButton(final.body)} (target 70 to 100)`);
  console.log(`builds used: ${JSON.stringify(final.builds_used ?? null)}`);
  console.log(`calls: compose, ${checked.calls.map((c) => c.kind).join(", ")} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(
    `showcase check: ${checked.ok ? `pass after ${checked.revisions} rewrite(s), it would send` : `HELD (${checked.reason}), the plain follow-up would send instead`}`,
  );
  const gate = writingFailures(input, final);
  console.log(`send gate (writing rules): ${gate.length ? gate.map((f) => `${f.code}: ${f.detail}`).join(" | ") : "pass"}`);
}

await firstEmail(
  "EN, Calgary pilates studio",
  prospect({
    company: "Core Lab Pilates",
    industry: "pilates studio",
    lang: "en",
    city: "Calgary",
    market: "CA",
    what: "A boutique reformer pilates studio with group classes and private sessions.",
    employees: 8,
    contact: { name: "Megan Ross", email: "megan@corelabpilates.example" },
  }),
);
await firstEmail(
  "ES, Monterrey plastics manufacturer (usted)",
  prospect({
    company: "Plásticos del Norte",
    industry: "fábrica de plásticos",
    lang: "es",
    city: "Monterrey",
    market: "MX",
    what: "Fabrican piezas de plástico inyectado para la industria automotriz y de electrodomésticos.",
    employees: 120,
    contact: { name: null, email: "ventas@plasticosdelnorte.example" },
  }),
);
await showcaseFollowup(
  "EN, Calgary law firm",
  prospect({
    company: "Bowman Family Law",
    industry: "law firm",
    lang: "en",
    city: "Calgary",
    market: "CA",
    what: "A family law firm handling divorce, custody and separation agreements.",
    employees: 12,
    contact: { name: "Jordan Bowman", email: "jordan@bowmanlaw.example" },
  }),
);
