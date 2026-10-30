/**
 * Real Rünna builds the showcase email may describe (Pedro, 2026-10-29: "use
 * examples like the analytics dashboard or the influencer platform or
 * greenlight or the project tracker or the brook book… you can choose what
 * examples to use based on what industry or what that company does").
 *
 * Each entry says what the build does for the person who uses it, never what
 * it is called or whose it is: cold emails name no client and no internal
 * product (Pedro, 2026-07-22), and the product names are in INTERNAL_NAMES
 * (lib/pitches/content-rules.ts) so the send gate holds any that slip through.
 * Every sentence here comes from the build's own repo (survey 2026-10-29) and
 * has no digit, so it can never trip the number gate. A build qualifies when it
 * exists and does what its entry says, pilots included (Pedro, 2026-10-29: "keep
 * the barcode generator"); the copy claims only "we built" and what it does,
 * never usage or results. Left out on purpose: the social reporting platform
 * (scaffold), inventory sync (shadow mode), the pitch-deck builder (internal),
 * the free check itself (it is the CTA), and this prospecting system (an email
 * about the machine writing it reads as a trick).
 *
 * Which builds may be described: the ones Pedro named on 2026-10-29 (analytics
 * dashboard, influencer platform, Greenlight, project tracker, Brookbook,
 * barcode generator) and the citeable in-house builds of RUNNA_CAPABILITIES
 * (Daily Briefings, the SnapPad tools; lib/runna/capabilities.ts, 2026-06-23).
 *
 * Two bars (Pedro, 2026-10-29: "dont be to strict… as long as the potential is
 * real an plausible and we can build it"). Past work: an entry says only what
 * the build really does; `learns` is true where the build improves from the
 * business's own feedback (Greenlight learns from starred pieces and edits).
 * Offers for the prospect: anything real we can build, a tool that learns from
 * their own data included, said as would/could.
 *
 * Library order matters: pickBuilds takes industry matches and universal fill
 * in this order, so the strongest proof comes first.
 *
 * The writer gets the language-resolved entries pickBuilds chooses and may
 * describe only those (the critic checks it against the same list).
 *
 * Pure — tested in tests/showcase.test.ts.
 */

import { normalizeIndustry, type SegmentIndustry } from "../learning/segments.ts";

type BuildCopy = {
  /** Who it was built for, as a kind of business or team: "a company that sells through dealers". */
  for_whom: string;
  /** What it does for them, one plain sentence. */
  does: string;
  /** How the AI or the automation does the work, in plain words. */
  how_it_works: string;
  /**
   * Other jobs the same approach fits, for the "what it could do for you" line:
   * an offer, never something this build already does.
   */
  same_idea?: string;
};

export type RunnaBuild = {
  id: string;
  en: BuildCopy;
  es: BuildCopy;
  /** Industries the same idea suits best (lib/learning/segments.ts). */
  fits: readonly SegmentIndustry[];
  /** Fits almost any business: used when nothing industry-specific does. */
  universal: boolean;
  /** It gets better from the business's own feedback (the repo shows it). */
  learns: boolean;
  /**
   * Never offered to a business this matches (industry or what_they_do,
   * accent-free, lower case): it is the kind of business the build tracks.
   */
  avoid?: RegExp;
};

/** What the writer and the critic see: one language, the id to report back. */
export type ShowcaseBuild = BuildCopy & { id: string; universal: boolean; learns: boolean };

/** The showcase email (writer.showcase "first") instead of the pain-led one. */
export function isShowcase(input: { showcase_builds?: readonly ShowcaseBuild[] | null }): boolean {
  return (input.showcase_builds?.length ?? 0) > 0;
}

export const RUNNA_BUILDS: readonly RunnaBuild[] = [
  // ── Universal ──────────────────────────────────────────────────────────────
  {
    // Moisty-Mango/snappad-dashboard: live; Sonnet writes the weekly analysis from
    // code-computed figures; apply/dismiss clicks feed later prompts.
    id: "sales-dashboard",
    en: {
      for_whom: "a brand that sells online and through several marketplaces",
      does: "One screen with sales, ad and email results, and a plain weekly verdict against the same week last year.",
      how_it_works: "The AI writes the weekly analysis and learns from which suggestions the owner uses.",
    },
    es: {
      for_whom: "una marca que vende en línea y en varios mercados digitales",
      does: "Una sola pantalla con ventas, anuncios y correos, y cada semana un veredicto simple contra la misma semana del año pasado.",
      how_it_works: "La IA escribe el análisis de cada semana y aprende de las recomendaciones que el dueño sí usa.",
    },
    fits: ["ecommerce", "retail", "distribution"],
    universal: true,
    learns: true,
  },
  {
    // Moisty-Mango/daily-briefings: in use; scheduled Claude agents read mail,
    // calendar, tasks and meeting notes; read-only.
    id: "daily-briefing",
    en: {
      for_whom: "a business owner with a full inbox",
      does: "A short summary every morning and evening of what needs attention today and what to prepare for tomorrow.",
      how_it_works: "The AI reads the owner's email, calendar, tasks and meeting notes to pick what matters.",
    },
    es: {
      for_whom: "un dueño de negocio con la bandeja de correo llena",
      does: "Un resumen corto cada mañana y cada tarde de lo que necesita atención hoy y de lo que hay que preparar para mañana.",
      how_it_works: "La IA lee el correo, el calendario, las tareas y las notas de juntas para elegir lo importante.",
    },
    fits: [],
    universal: true,
    learns: false,
  },
  {
    // Moisty-Mango/snaptrack: live; Haiku task coach and request reviewer
    // (advisory), automatic alerts to the owner.
    id: "request-tracker",
    en: {
      for_whom: "a team that juggles requests from several departments",
      does: "A shared board where every request is checked before it's sent and the right person hears about it right away.",
      how_it_works: "The AI flags vague requests and suggests who should own each one and by when.",
    },
    es: {
      for_whom: "un equipo que recibe pedidos de varias áreas",
      does: "Un tablero compartido donde cada solicitud se revisa antes de enviarse y la persona correcta se entera al momento.",
      how_it_works: "La IA detecta solicitudes vagas y sugiere a quién asignarlas y para cuándo.",
    },
    fits: [],
    universal: true,
    learns: false,
  },

  // ── Industry-specific ──────────────────────────────────────────────────────
  {
    // Moisty-Mango/snappad-dealer-heatmap: live, used by the B2B team. No AI:
    // the upload checks are automation. It does NOT flag dealers going quiet.
    id: "dealer-map",
    en: {
      for_whom: "a manufacturer that sells through dealers",
      does: "A map of which dealers buy, how much and where, with order sheets ready to send.",
      how_it_works: "New sales files are checked and matched to each dealer automatically.",
    },
    es: {
      for_whom: "un fabricante que vende a través de distribuidores",
      does: "Un mapa de qué distribuidores compran, cuánto y dónde, con hojas de pedido listas para enviar.",
      how_it_works: "Los nuevos archivos de ventas se revisan y se asignan a cada distribuidor solos.",
    },
    // Manufacturers only, and never a dealer or distributor: that is the kind of
    // business this map tracks, so describing it to one points at the
    // manufacturer behind it.
    fits: ["manufacturing"],
    universal: false,
    learns: false,
    avoid: /dealer|distribut|concesionari|mayorist|wholesal|reseller|revendedor/,
  },
  {
    // Runna-Ad/runna-barcode-studio: deployed, run on test data so far ("we
    // built", never "a chain uses it"). No AI: validated rows, rule-bound batch
    // generation, folders, a shared-sheet sync. Pedro, 2026-10-29: the same idea
    // fits any job that makes the same thing over and over from data.
    id: "label-generator",
    en: {
      for_whom: "suppliers that ship to big retail chains",
      does: "Turns a spreadsheet of products into print-ready barcode labels in each chain's style, all at once.",
      how_it_works: "Every row is checked against the chain's rules before a label is made.",
      same_idea: "Any job that makes the same thing over and over from a list follows the same idea: shipping labels, price tags, shelf labels, certificates, standard documents.",
    },
    es: {
      for_whom: "proveedores que surten a grandes cadenas comerciales",
      does: "Convierte una hoja de cálculo de productos en etiquetas de código de barras listas para imprimir, con el estilo de cada cadena, todas de una vez.",
      how_it_works: "Cada fila se revisa contra las reglas de la cadena antes de generar la etiqueta.",
      same_idea: "Cualquier trabajo que repite lo mismo una y otra vez a partir de una lista sigue la misma idea: guías de envío, etiquetas de precio, etiquetas de anaquel, constancias, documentos estándar.",
    },
    fits: ["retail", "distribution", "manufacturing", "ecommerce", "logistics"],
    universal: false,
    learns: false,
  },
  {
    // Moisty-Mango/production-tracker: deployed pilot ("we built", never "floor
    // teams use it"). No AI: a scheduled job marks stalled machines.
    id: "shop-floor-tracker",
    en: {
      for_whom: "a factory running molding machines",
      does: "A phone app where operators log output, rejects and downtime, and supervisors see every machine live.",
      how_it_works: "A machine that stops reporting is flagged, and shift reports build themselves.",
    },
    es: {
      for_whom: "una fábrica con máquinas de moldeo",
      does: "Una aplicación en el celular donde los operadores registran producción, rechazos y paros, y los supervisores ven cada máquina en vivo.",
      how_it_works: "Una máquina que deja de reportar se marca sola, y los reportes por turno se arman solos.",
    },
    fits: ["manufacturing"],
    universal: false,
    learns: false,
  },
  {
    // Moisty-Mango/social-influencers: in daily use. No AI: the grade is a
    // formula; contract emails, e-sign and a daily digest are automation.
    id: "creator-manager",
    en: {
      for_whom: "a brand that works with a lot of influencers",
      does: "One place for every creator deal: content owed, payments, products sent and signed contracts.",
      how_it_works: "It warns before a contract runs out or a payment is due.",
    },
    es: {
      for_whom: "una marca que trabaja con muchos creadores de contenido",
      does: "Un solo lugar para cada acuerdo con creadores: contenido pendiente, pagos, productos enviados y contratos firmados.",
      how_it_works: "Avisa antes de que venza un contrato o toque un pago.",
    },
    fits: ["fitness", "beauty", "restaurant", "hospitality", "ecommerce", "retail"],
    universal: false,
    learns: false,
  },
  {
    // Runna-Ad/greenlight: live; Sonnet drafts scripts and copy from the brief
    // with brand rules and starred pieces, proposes style lessons from starred
    // winners and people's edits (switched on by an admin); a person approves
    // every draft.
    id: "ad-approval-portal",
    en: {
      for_whom: "a marketing team that produces ads for its clients",
      does: "Every ad goes from brief to finished piece in one place, with a private page where the client approves it.",
      how_it_works: "The AI drafts scripts and copy in the brand's style and learns from the pieces the team stars and the edits people make.",
    },
    es: {
      for_whom: "un equipo que produce anuncios para sus clientes",
      does: "Cada anuncio va del encargo a la pieza terminada en un solo lugar, con una página privada donde el cliente lo aprueba.",
      how_it_works: "La IA escribe guiones y textos con el estilo de la marca y aprende de las piezas que el equipo marca como mejores y de sus correcciones.",
    },
    fits: ["realestate", "retail", "hospitality"],
    universal: false,
    learns: true,
  },
  {
    // Moisty-Mango/snappad-launch-tool: live. No AI: gates, overdue flags, a log.
    id: "launch-tracker",
    en: {
      for_whom: "a company that launches new products often",
      does: "A step-by-step launch checklist for each new product, where each step opens only when the last one is done.",
      how_it_works: "Anything running late is flagged and every change is logged.",
    },
    es: {
      for_whom: "una empresa que lanza productos nuevos seguido",
      does: "Una lista paso a paso para lanzar cada producto nuevo, donde cada paso se abre solo cuando el anterior está terminado.",
      how_it_works: "Lo atrasado se avisa solo y cada cambio queda registrado.",
    },
    fits: ["manufacturing", "ecommerce", "retail"],
    universal: false,
    learns: false,
  },
];

/** At most this many builds are offered; the email describes one, two at most. */
export const MAX_OFFERED_BUILDS = 4;
const MAX_SPECIFIC_BUILDS = 3;

/**
 * The builds to offer for one prospect: those that fit its industry first (at
 * most three, library order), then universal ones up to MAX_OFFERED_BUILDS.
 * The industry comes from prospect.industry, else from what_they_do.
 */
export function pickBuilds(input: {
  industry: string | null | undefined;
  what_they_do?: string | null;
  lang: "en" | "es";
}): ShowcaseBuild[] {
  let segment = normalizeIndustry(input.industry);
  if (segment === "other") segment = normalizeIndustry(input.what_they_do);
  const about = fold(`${input.industry ?? ""} ${input.what_they_do ?? ""}`);
  const allowed = RUNNA_BUILDS.filter((b) => !b.avoid?.test(about));
  const specific = segment === "other" ? [] : allowed.filter((b) => b.fits.includes(segment)).slice(0, MAX_SPECIFIC_BUILDS);
  const universal = allowed.filter((b) => b.universal && !specific.includes(b));
  return [...specific, ...universal]
    .slice(0, MAX_OFFERED_BUILDS)
    .map((b) => ({ id: b.id, universal: b.universal, learns: b.learns, ...b[input.lang] }));
}

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** The ids the writer reported that were really offered, in its order, no repeats. */
export function offeredBuildIds(reported: unknown, offered: readonly ShowcaseBuild[]): string[] {
  if (!Array.isArray(reported)) return [];
  const ids = new Set(offered.map((b) => b.id));
  return [...new Set(reported.filter((x): x is string => typeof x === "string" && ids.has(x)))];
}
