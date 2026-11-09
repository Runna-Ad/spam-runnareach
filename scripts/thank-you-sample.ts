/**
 * Prints two real AI thank-you drafts (Desloges forward, a Spanish redirect)
 * from the wrong_person prompt. Local check only, nothing is saved or sent.
 *   node --env-file=../S.P.A.M/.env.local --experimental-strip-types scripts/thank-you-sample.ts
 */
import { composeReplyDraftWithClaude, type DraftComposerInput } from "../lib/replies/draft-composer.ts";

const base: DraftComposerInput = {
  contactFirstName: null,
  companyName: "Desloges Law Group Professional Corporation",
  language: "en",
  intent: "wrong_person",
  replySubject: "RE: what I didn't see on desloges.ca",
  replyBody:
    "Hello Henry,\n\nI have forwarded your message to our management team, for their review. Thank you!\n\nRegards,\n\nAdele Desloges\nReception & Administrative Assistant\nDesloges Law Group Professional Corporation",
  threadSubject: "what I didn't see on desloges.ca",
  originalPitchBody:
    "Hi there,\n\nI spent some time on desloges.ca and noticed intake runs through a contact form with no follow-up...\n\nHenry\nRunna Advertising",
  whatTheyDo: "Immigration and family law firm in Toronto",
  painSummary: "Slow intake follow-up",
  senderFirstName: "Henry",
  agencyName: "Runna Advertising",
};

const cases: DraftComposerInput[] = [
  base,
  {
    ...base,
    language: "es",
    companyName: "Clínica Dental Sol",
    replySubject: "RE: Una idea para Clínica Dental Sol",
    replyBody:
      "Buen día, yo no veo estos temas. Le sugiero escribir a la Dra. Laura Méndez, laura@clinicasol.mx.\n\nSaludos,\nRecepción",
    threadSubject: "Una idea para Clínica Dental Sol",
    senderFirstName: "Nils",
  },
];

for (const c of cases) {
  const r = await composeReplyDraftWithClaude(c);
  if (!r.ok) {
    console.log("FAILED:", r.reason, r.error);
    continue;
  }
  console.log(`--- ${c.language} · ${r.model} · $${r.usage.cost_usd?.toFixed(4)}\nSubject: ${r.draft.subject}\n\n${r.draft.body}\n`);
}
