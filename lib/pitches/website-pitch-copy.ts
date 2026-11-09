/**
 * The no-website pitch's words: the Claude prompt and the two fallback
 * templates (lib/pitches/website-pitch-stage.ts sends them).
 *
 * Proven facts (Pedro, 2026-11-09, after CrushCamp's hard no): v1 told every
 * one of these prospects "I work with [industry] businesses across Canada",
 * "most of the business owners I talk to in [industry] tell me…" and offered
 * "examples from [industry] businesses we've built for", and it asked "is not
 * having a website a deliberate choice". None of it could be shown. v2 says
 * what we build, and about them only the one thing we hold: their Google
 * listing shows no website, said as exactly that.
 *
 * v3 (review, 2026-11-09): not even that. discoverWebsiteViaPlaces
 * (lib/discover/pipeline-stage.ts) comes back empty without a Places key,
 * without a matched listing, for a Facebook or Instagram link, on a failed
 * name match or a slow site, so "your listing shows no website" is a guess
 * too. These emails say nothing about the business beyond its name and
 * industry: only our offer.
 *
 * Pure: zero server imports.
 */

export const WEBSITE_PROMPT_VERSION = "website-v3-2026-11-09";

export type WebsiteCopyInput = {
  companyName: string;
  industry: string;
  language: "en" | "es";
  firstName: string | null;
  /** The case-study line (websiteCaseStudyLine), or null. */
  caseStudyLine: string | null;
  /** Two-line sign-off, e.g. "Nils\nRunna Advertising" (lib/pitches/sender-identity). */
  signature: string;
};

function greetingFor(o: Pick<WebsiteCopyInput, "language" | "firstName" | "companyName">): string {
  // "Hi there," is banned project-wide (reads as a mail merge); the team form instead.
  if (o.language === "es") return o.firstName ? `Hola ${o.firstName},` : `Hola equipo de ${o.companyName},`;
  return o.firstName ? `Hi ${o.firstName},` : `Hi ${o.companyName} team,`;
}

/**
 * The line a matching case study adds: what the work is, never who it was for
 * or how often we do it (v1 said "we do this all the time for [industry] like
 * yours"). The case study id is still recorded for the learning loop.
 */
export function websiteCaseStudyLine(language: "en" | "es"): string {
  return language === "es"
    ? "La mayor parte del trabajo está en que los encuentre la gente que ya anda buscando lo que ustedes hacen."
    : "Most of the work is getting you found by the people already looking for what you do.";
}

export function websiteSubject(o: Pick<WebsiteCopyInput, "language" | "companyName">): string {
  return o.language === "es" ? `una idea para ${o.companyName}` : `an idea for ${o.companyName}`;
}

/** The email body, in the prospect's language: our offer, and about them only their name and industry. */
export function websiteFallbackPitch(o: WebsiteCopyInput): { subject: string; body: string } {
  const greeting = greetingFor(o);
  const caseStudyBlock = o.caseStudyLine ? `\n\n${o.caseStudyLine}\n` : "";
  if (o.language === "es") {
    return {
      subject: websiteSubject(o),
      body: `${greeting}

Quise compartirles una idea para ${o.companyName}.

Hacemos sitios web que ayudan a que a un negocio lo encuentre la gente que ya está buscando lo que ofrece. Lo hacemos simple: en línea en 2 o 3 semanas, a un costo que tiene sentido para un negocio en crecimiento, y hecho para traer clientes reales, no solo para verse bonito.

Lo que un buen sitio web hace por un negocio de ${o.industry}:
✓ Aparece cuando alguien cerca busca lo que ustedes ofrecen
✓ Genera confianza (mucha gente busca un negocio en Google antes de llamar)
✓ Recibe consultas a cualquier hora, incluso fuera de horario
✓ Les da un solo lugar a dónde mandar a la gente, también desde redes sociales
✓ Los ayuda a destacar como la opción profesional${caseStudyBlock}

Si les sirve, con gusto les muestro lo que haríamos para ${o.companyName}.

¿Vale la pena una llamada corta?

${o.signature}`,
    };
  }
  return {
    subject: websiteSubject(o),
    body: `${greeting}

I wanted to share a quick idea for ${o.companyName}.

We build websites that get a business found by the people already searching for what it offers. We keep it simple: online in 2 to 3 weeks, at a cost that makes sense for a growing business, and built to bring in real customers, not just look pretty.

What a good website does for a ${o.industry} business:
✓ Shows up when people nearby search for what you offer
✓ Builds trust (people often look a business up before they call)
✓ Takes enquiries around the clock, even after hours
✓ Gives you one place to send people from anywhere, social media included
✓ Helps you stand out as the professional choice${caseStudyBlock}

If it's useful, I'm happy to show you what we'd build for ${o.companyName}.

Worth a quick chat?

${o.signature}`,
  };
}

/** The Claude (Haiku) prompt: the English structure to adapt, and the rules that keep it to what we can show. */
export function websitePitchPrompt(o: WebsiteCopyInput & { market: "CA" | "MX" | "US" | "LATAM" }): string {
  const marketLabel = o.market === "MX" ? "Mexico" : o.market === "US" ? "the US" : "Canada";
  // The structure is the fallback template in the prospect's own language, placeholders kept.
  const structure = websiteFallbackPitch({ ...o, industry: `[${o.industry}]` });
  return `You are a sales email writer for Rünna Advertising, a digital marketing and web design agency.

Write a cold email to ${o.companyName}, a ${o.industry} business in ${marketLabel}.
The goal is to offer them a professional website built by Rünna.

${o.language === "es" ? "Write the email in Spanish." : "Write the email in English."}

Use this structure, replacing every [${o.industry}] placeholder with natural, industry-specific language:

Subject: ${structure.subject}

${structure.body}

Rules:
- About ${o.companyName}, say only its name and that it is a ${o.industry} business: we know nothing else about them.
- Never say or guess anything about their website, Google listing, online presence or social media: not whether they have one, not what it shows, not what they lack, what it costs them or what their customers do. Never ask whether any of it is a choice.
- Say what we build and how it helps a business like theirs. Never say who we work with, have worked with, built for or talk to, and never what other owners say or tell us: we can't show any of it.
- Replace every [${o.industry}] placeholder with industry-specific, natural-sounding language
- Keep tone warm and conversational, not salesy or pushy
- 150 to 250 words in the body
- No em dashes (—): use commas or periods
- Plain words a business owner uses: never "leads", "funnel", "conversion", "optimize"
- No numbers other than the ones already in the structure above
- End with the sign-off exactly as shown, nothing after it
- Return ONLY the email. First line: "Subject: ..." then blank line then body. Nothing else.`;
}
