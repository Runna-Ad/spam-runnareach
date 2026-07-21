/**
 * Industry-specific fallback pitch templates.
 *
 * Used when Claude is unavailable or fails. Replaces the old generic heuristic
 * with polished, Pedro-authored copy that:
 *   - Matches the prospect's industry (8 buckets + generic fallback)
 *   - CTAs to the Runna Inefficiency Hunter (no email / no call friction)
 *   - Works in both EN (CA market) and ES (MX market)
 *
 * Templates authored by Pedro De Velasco. Do not edit body copy without his review.
 */

import type { ComposedPitch, GeneratorInputs } from "./generator.ts";
import { pickAddressContact } from "../research/email-utils.ts";

export const HUNTER_URL = "https://runna-hunter.vercel.app/";

/**
 * The Inefficiency Hunter is one app that toggles between the Canadian and
 * Mexican market in-page; it reads a `?market=` param to pre-select on load.
 * Build the CTA so an English pitch lands the prospect on the Canadian version
 * and a Spanish pitch on the Mexican one (the app's default).
 */
export function hunterUrlForLanguage(language: "en" | "es" | null | undefined): string {
  const market = language === "en" ? "ca" : "mx";
  return `${HUNTER_URL}?market=${market}`;
}

// ── Industry keyword matching ─────────────────────────────────────────────────
// Prospect.industry is free-text (e.g. "DTC coffee", "Retail fashion", "real estate").
// Matching is first-keyword-wins; "other" is always the fallback.

type TemplateKey =
  | "ecommerce"
  | "restaurant"
  | "realestate"
  | "professional"
  | "retail"
  | "automotive"
  | "health"
  | "hotel"
  | "beach_club"
  | "villa_rental"
  | "other";

// Hospitality sub-types checked FIRST so "hotel restaurant" → hotel, not restaurant.
const INDUSTRY_KEYWORDS: [TemplateKey, string[]][] = [
  ["hotel",        ["hotel", "boutique hotel", "inn", "resort", "lodging", "hospedaje", "hotel boutique", "posada", "hostería", "motel", "suites", "hospitality"]],
  ["beach_club",   ["beach club", "beach bar", "club de playa", "beach lounge", "palapa"]],
  ["villa_rental", ["villa", "vacation rental", "holiday rental", "renta vacacional", "vacation home", "alquiler vacacional"]],
  ["ecommerce",    ["dtc", "ecommerce", "e-commerce", "d2c", "dropshipping", "online store", "tienda en línea", "tienda online", "shopify", "woocommerce", "tiendanube"]],
  ["restaurant",   ["restaurant", "food", "beverage", "cafe", "coffee", "bar", "dining", "brewery", "bakery", "alimentos", "bebidas", "restaurante", "comida", "taqueria", "cantina", "cafetería"]],
  ["realestate",   ["real estate", "construction", "property", "realty", "bienes raíces", "construcción", "inmobiliaria", "broker", "realtor", "housing"]],
  ["professional", ["consulting", "consultancy", "law", "legal", "accounting", "finance", "advisory", "servicios profesionales", "consultoría", "despacho", "notaría", "firma"]],
  ["retail",       ["retail", "consumer brand", "boutique", "fashion", "apparel", "clothing", "ropa", "moda", "tienda física", "marca de consumo"]],
  ["automotive",   ["auto", "automotive", "car", "dealership", "vehicle", "truck", "dealer", "automotriz", "distribuidor", "agencia de autos", "concesionario"]],
  ["health",       ["health", "wellness", "medical", "clinic", "fitness", "gym", "dental", "spa", "salud", "clínica", "medicina", "doctor", "fisio", "nutrición"]],
];

export function detectIndustryKey(industry: string | null): TemplateKey {
  if (!industry) return "other";
  const lower = industry.toLowerCase();
  for (const [key, keywords] of INDUSTRY_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return key;
  }
  return "other";
}

// ── Template definitions ──────────────────────────────────────────────────────

type LangTemplate = {
  subject: string;
  preview_text: string;
  /** Use {first_name}, {company}, {link} as placeholders. */
  body: string;
};

type IndustryTemplate = {
  key: TemplateKey;
  label_en: string;
  label_es: string;
  en: LangTemplate;
  es: LangTemplate;
};

const TEMPLATES: IndustryTemplate[] = [
  {
    key: "ecommerce",
    label_en: "E-commerce / D2C Brand",
    label_es: "E-commerce / Marca D2C",
    en: {
      subject: "what your ad budget is quietly losing",
      preview_text: "Find out exactly how much {company} loses every month to marketing that doesn't convert — 30 seconds.",
      body: `Hi {first_name},

Uncomfortable question: do you know how much {company} loses every month to marketing that doesn't convert? Almost no one does, and that blind spot is the real cost.

We built a 30-second diagnostic that cross-references real wage data and your industry's benchmarks, and hands you the exact number. No email, no call.

Rünna has spent 12 years making marketing produce measurable results. This shows you where to start.

👉 Your number is here: {link}

Pedro
Rünna`,
    },
    es: {
      subject: "el dinero que tu marca pierde cada mes",
      preview_text: "Descubre exactamente cuántos pesos al mes pierde {company} en marketing que no convierte, en 30 segundos.",
      body: `Hola {first_name},

Pregunta incómoda: ¿sabes cuántos pesos al mes pierde {company} en marketing que no convierte? Casi nadie lo sabe, y ese es justo el problema.

Armamos un diagnóstico que cruza salarios reales y benchmarks de tu industria, y te da el número exacto. 30 segundos. Sin correo, sin llamada.

En Rünna llevamos 12 años haciendo que el marketing genere resultados medibles. Esto te muestra dónde empezar.

👉 Tu número está aquí: {link}

Pedro
Rünna`,
    },
  },

  {
    key: "restaurant",
    label_en: "Restaurant / Food & Beverage",
    label_es: "Restaurante / Alimentos & Bebidas",
    en: {
      subject: "the cost of guessing with your marketing",
      preview_text: "One number tells you exactly how much leaks out of your marketing each month. 30 seconds, no email.",
      body: `Hi {first_name},

Most restaurants split their budget across Instagram, delivery apps and Google with no real read on what's working, and never see how much leaks out along the way.

We built a tool that tells you in 30 seconds: a dollar figure, based on real data for your industry. No email required.

Rünna produces marketing that sells, not just marketing that looks good. But first, see your number.

👉 {link}

Pedro
Rünna`,
    },
    es: {
      subject: "cuánto te cuesta el marketing improvisado",
      preview_text: "Un número en pesos te dice cuánto dinero sale de tu marketing cada mes. 30 segundos, sin correo.",
      body: `Hola {first_name},

La mayoría de los restaurantes reparte presupuesto entre Instagram, Rappi y Google sin saber qué jala, y nunca ven cuánto dinero se va en el camino.

Hicimos una herramienta que te lo dice en 30 segundos: un número en pesos, basado en datos reales de tu industria. No pide correo.

En Rünna producimos marketing que vende, no que solo se ve bonito. Pero primero, mira tu número.

👉 {link}

Pedro
Rünna`,
    },
  },

  {
    key: "realestate",
    label_en: "Real Estate / Construction",
    label_es: "Bienes Raíces / Construcción",
    en: {
      subject: "{company}'s leads are slipping through follow-up",
      preview_text: "Lead gen isn't the problem. The problem is how many die between first contact and follow-up, and what that costs.",
      body: `Hi {first_name},

In real estate, generating leads is rarely the problem. The problem is how many die between first contact and follow-up, and what that costs you in dollars.

We built a 30-second diagnostic that puts an exact number on that leak. No email, no commitment.

Rünna has spent 12 years turning marketing into measurable results. This shows you where to look first.

👉 Calculate your leak: {link}

Pedro
Rünna`,
    },
    es: {
      subject: "los leads que {company} está dejando ir",
      preview_text: "El 70% de los leads se pierde entre el primer contacto y el seguimiento. Ese costo tiene un número exacto.",
      body: `Hola {first_name},

En bienes raíces, generar leads casi nunca es el problema. El problema es cuántos se pierden entre el primer contacto y el seguimiento, y lo que eso cuesta en pesos.

Te armamos un diagnóstico de 30 segundos que pone número exacto a esa fuga. Sin correo, sin compromiso.

Rünna lleva 12 años convirtiendo marketing en resultados medibles. Esto te muestra por dónde.

👉 Calcula tu fuga: {link}

Pedro
Rünna`,
    },
  },

  {
    key: "professional",
    label_en: "Professional Services",
    label_es: "Servicios Profesionales",
    en: {
      subject: "is {company}'s marketing a return or a cost?",
      preview_text: "Most professional services firms spend more than they realize on marketing that can't be traced to revenue.",
      body: `Hi {first_name},

In professional services, most marketing is inconsistent: a campaign here, a post there, nothing tied to a number. And it costs more than it looks.

We built a tool that tells you exactly how much, in 30 seconds, using real data for your industry. No email required.

At Rünna we work by one rule: if you can't measure it, it doesn't count. Start by measuring this.

👉 {link}

Pedro
Rünna`,
    },
    es: {
      subject: "¿el marketing de {company} genera retorno o solo gasto?",
      preview_text: "La mayoría de los negocios de servicios gasta más de lo que cree en marketing que no se puede rastrear.",
      body: `Hola {first_name},

En servicios profesionales casi todo el marketing es inconsistente: una campaña aquí, un post allá, nada conectado a un número. Y eso cuesta más de lo que parece.

Hicimos una herramienta que te dice exactamente cuánto, en 30 segundos, con datos reales de tu industria. No pide correo.

En Rünna trabajamos bajo una regla: si no se puede medir, no sirve. Empieza por medir esto.

👉 {link}

Pedro
Rünna`,
    },
  },

  {
    key: "retail",
    label_en: "Retail / Consumer Brand",
    label_es: "Retail / Marca de Consumo",
    en: {
      subject: "what a scattered brand is costing {company}",
      preview_text: "Inconsistent packaging, shifting message, invisible cost. A 30-second diagnostic turns it into a real dollar figure.",
      body: `Hi {first_name},

In retail, a scattered brand, inconsistent packaging, a message that shifts channel to channel, costs real sales. The trouble is that cost stays invisible until someone calculates it.

We built a 30-second diagnostic that turns it into a concrete dollar figure. No email, no call.

Rünna has spent 12 years producing marketing that drives results. See where you're losing first.

👉 Your number here: {link}

Pedro
Rünna`,
    },
    es: {
      subject: "lo que una marca dispersa le cuesta a {company}",
      preview_text: "Empaque inconsistente, mensajes que cambian por canal, costo invisible. Un diagnóstico de 30 seg lo vuelve un número.",
      body: `Hola {first_name},

En retail, una marca dispersa, empaque inconsistente, mensajes que cambian por canal, cuesta ventas reales. El problema es que ese costo es invisible hasta que alguien lo calcula.

Armamos un diagnóstico de 30 segundos que lo vuelve un número concreto en pesos. Sin correo, sin llamada.

Rünna lleva 12 años produciendo marketing que genera resultados. Mira primero dónde estás perdiendo.

👉 Tu número aquí: {link}

Pedro
Rünna`,
    },
  },

  {
    key: "automotive",
    label_en: "Automotive / Dealerships",
    label_es: "Automotriz / Distribuidores",
    en: {
      subject: "the money stuck in {company}'s slow processes",
      preview_text: "Lead follow-up, floor-to-digital handoff, manual reporting. There's a dollar number on each of those leaks.",
      body: `Hi {first_name},

In automotive, more money is lost than people think in slow processes: prospect follow-up, the handoff between floor and digital, manual reporting.

We built a diagnostic that puts a dollar number on those leaks, 30 seconds, real industry data, no email required.

Rünna has spent 12 years building measurable marketing for demanding brands. This shows you where to start.

👉 {link}

Pedro
Rünna`,
    },
    es: {
      subject: "el dinero atorado en los procesos de {company}",
      preview_text: "Seguimiento de prospectos, comunicación piso-digital, reportes manuales. Cada uno de esos tiene un costo exacto.",
      body: `Hola {first_name},

En el sector automotriz se pierde más dinero del que se cree en procesos lentos: seguimiento de prospectos, comunicación entre piso y digital, reportes manuales.

Te hicimos un diagnóstico que pone número en pesos a esas fugas, 30 segundos, datos reales de industria, sin pedir correo.

Rünna lleva 12 años haciendo marketing medible para marcas exigentes. Esto te muestra por dónde arrancar.

👉 {link}

Pedro
Rünna`,
    },
  },

  {
    key: "health",
    label_en: "Health & Wellness",
    label_es: "Salud & Wellness",
    en: {
      subject: "{company}: patients who look but never book",
      preview_text: "High traffic, low bookings — there's an exact cost to that gap. 30 seconds to see yours.",
      body: `Hi {first_name},

In health and wellness the problem is rarely traffic. It's conversion. Plenty of people look, few book, and manual follow-up falls through. That has an exact cost.

We built a tool that tells you what it is in 30 seconds, using real data for your industry. No email required.

Rünna has spent 12 years turning marketing into measurable results. Start by seeing your number.

👉 {link}

Pedro
Rünna`,
    },
    es: {
      subject: "{company}: pacientes que miran y nunca agendan",
      preview_text: "Mucha atención, pocas citas, el seguimiento se cae. Hay un costo exacto a esa brecha. 30 segundos para verlo.",
      body: `Hola {first_name},

En salud y wellness el problema rara vez es atención, es conversión. Mucha gente ve, pocos agendan, y el seguimiento manual se cae. Eso tiene un costo exacto.

Armamos una herramienta que te lo dice en 30 segundos, con datos reales de tu industria. No pide correo.

Rünna lleva 12 años convirtiendo marketing en resultados medibles. Empieza viendo tu número.

👉 {link}

Pedro
Rünna`,
    },
  },

  // ── Hospitality sub-types (Cancún / Los Cabos / tourist hubs) ─────────────
  // Copy by Pedro De Velasco — Templates_Cancun_LosCabos_Hospitality.docx
  // English by design: these prospects market to North American travellers.
  // Spanish versions are provided as fallback for non-tourist-hub hospitality.
  {
    key: "hotel",
    label_en: "Boutique & Independent Hotels",
    label_es: "Hoteles Boutique & Independientes",
    en: {
      subject: "{company}'s OTA commission, recaptured",
      preview_text: "The gap between 15–30% OTA commission and 4.5% direct is real money. 30 seconds to see {company}'s number.",
      body: `Hi {first_name},

You already know the number that stings: 15–30% of every Booking.com and Expedia reservation gone before the guest checks in. A direct booking costs closer to 4.5%.

The gap between those two numbers — for {company} specifically — is real money you could be keeping every month. We built a 30-second tool that calculates it.

Rünna has 12 years producing marketing that drives measurable results. And we operate in both Mexico and Canada — so we know how to sell your destination to the travellers who actually book it.

👉 See {company}'s recapture number: {link}

Pedro
Rünna`,
    },
    es: {
      subject: "La comisión de OTA de {company}, recuperada",
      preview_text: "La brecha entre 15–30% de comisión OTA y 4.5% de reserva directa es dinero real. 30 segundos para verlo.",
      body: `Hola {first_name},

Ya sabes el número que duele: 15–30% de cada reserva de Booking.com y Expedia se va antes de que el huésped llegue. Una reserva directa cuesta cerca del 4.5%.

La diferencia entre esos dos números — para {company} específicamente — es dinero real que podrías estar quedándote cada mes. Armamos una herramienta de 30 segundos que lo calcula.

En Rünna llevamos 12 años produciendo marketing que genera resultados medibles. Y operamos en México y Canadá — sabemos vender tu destino a los viajeros que realmente reservan.

👉 Ve el número de {company}: {link}

Pedro
Rünna`,
    },
  },

  {
    key: "beach_club",
    label_en: "Beach Clubs & Destination Restaurants",
    label_es: "Beach Clubs & Restaurantes de Destino",
    en: {
      subject: "The tourists walking past {company}",
      preview_text: "In Cancún and Los Cabos, the hard part isn't the experience. It's getting discovered by the right travellers first.",
      body: `Hi {first_name},

In Cancún and Los Cabos, the hard part isn't the experience — it's getting discovered by the right travellers before they've already committed elsewhere. Most venues market to whoever happens to scroll by.

We built a 30-second diagnostic that shows where {company}'s marketing is leaking those guests — and what it costs. No email, no call.

Rünna operates in both Mexico and Canada — we don't just produce marketing that fills tables, we know the North American traveller you're trying to reach.

👉 {link}

Pedro
Rünna`,
    },
    es: {
      subject: "Los turistas que pasan de largo de {company}",
      preview_text: "En Cancún y Los Cabos, lo difícil no es la experiencia. Es que te descubran antes de que reserven en otro lado.",
      body: `Hola {first_name},

En Cancún y Los Cabos, lo difícil no es la experiencia — es que los viajeros correctos te descubran antes de comprometerse con otra opción. La mayoría de los venues le hablan a quien aparece en el scroll.

Armamos un diagnóstico de 30 segundos que muestra dónde {company} pierde esos huéspedes y cuánto cuesta. Sin correo, sin llamada.

En Rünna operamos en México y Canadá — no solo producimos marketing, conocemos al viajero norteamericano que quieres alcanzar.

👉 {link}

Pedro
Rünna`,
    },
  },

  {
    key: "villa_rental",
    label_en: "Villa Rentals & Boutique Hospitality",
    label_es: "Rentas de Villas & Hospedaje Boutique",
    en: {
      subject: "What {company}'s empty nights are worth",
      preview_text: "Nights that go unbooked because the marketing reaches the wrong traveller, plus platform fees on the nights that do book.",
      body: `Hi {first_name},

In villa and boutique rentals, the leak is quiet: nights that go unbooked because the marketing reaches the wrong traveller, plus platform fees eating the nights that do book.

We built a 30-second tool that puts an exact dollar figure on it — for {company} specifically. No email required.

Rünna has 12 years of measurable creative work, and we operate on both sides of the border — so we know the Mexican market and the North American traveller who books it. That's the difference between an OTA listing and a destination people seek out by name.

👉 See your number: {link}

Pedro
Rünna`,
    },
    es: {
      subject: "Lo que valen las noches vacías de {company}",
      preview_text: "Noches sin reservar por llegar al viajero equivocado, más comisiones de plataforma en las que sí se reservan.",
      body: `Hola {first_name},

En rentas de villas y hospedaje boutique, la fuga es silenciosa: noches sin reservar porque el marketing llega al viajero equivocado, más comisiones de plataforma en las que sí se reservan.

Armamos una herramienta de 30 segundos que pone número exacto a eso — para {company} específicamente. Sin correo.

En Rünna llevamos 12 años de trabajo creativo medible, y operamos a ambos lados de la frontera — conocemos el mercado mexicano y al viajero norteamericano que lo reserva. Esa es la diferencia entre un listing de OTA y un destino que la gente busca por nombre.

👉 Ve tu número: {link}

Pedro
Rünna`,
    },
  },

  {
    key: "other",
    label_en: "Other",
    label_es: "Otro",
    en: {
      subject: "where is {company}'s money actually going?",
      preview_text: "Most businesses spend more on marketing in 2026 with no clear read on what works. 30 seconds to see your number.",
      body: `Hi {first_name},

Heading into 2026, most businesses are spending more on marketing and more hours on it, with no clear read on which channels actually pay back.

We built a 30-second diagnostic that puts an exact dollar figure on that leak. Real industry data. No email required.

Rünna has spent 12 years producing marketing that drives measurable results. This tells you where to start.

👉 {link}

Pedro
Rünna`,
    },
    es: {
      subject: "¿dónde se está yendo el dinero de {company}?",
      preview_text: "La mayoría de los negocios en México gasta más en marketing en 2026 sin saber qué funciona. 30 seg para saberlo.",
      body: `Hola {first_name},

El reto de 2026 para casi cualquier negocio en México no es falta de clientes, es falta de foco. Presupuesto repartido entre canales sin saber cuál vende.

Te hicimos un diagnóstico de 30 segundos que pone número exacto a esa fuga. Datos reales de industria. Sin correo.

Rünna lleva 12 años produciendo marketing que genera resultados medibles. Esto te dice por dónde empezar.

👉 {link}

Pedro
Rünna`,
    },
  },
];

const TEMPLATE_MAP = new Map(TEMPLATES.map((t) => [t.key, t]));

// ── Renderer ──────────────────────────────────────────────────────────────────

function extractFirstName(fullName: string | null | undefined): string | null {
  if (!fullName?.trim()) return null;
  return fullName.trim().split(/\s+/)[0] ?? null;
}

function applyVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

/**
 * Render an industry template as a ComposedPitch.
 * Called when Claude fails — produces a polished generic pitch instead of heuristic slop.
 */
export function renderIndustryTemplate(
  input: GeneratorInputs,
  claudeError: string,
): ComposedPitch {
  const lang = input.prospect.language;
  const industryKey = detectIndustryKey(input.prospect.industry);
  const template = TEMPLATE_MAP.get(industryKey) ?? TEMPLATE_MAP.get("other")!;
  const tpl = lang === "es" ? template.es : template.en;

  // Contact resolution — same priority order as the main generator.
  const contact = pickAddressContact(input.contacts);

  const firstName =
    extractFirstName(contact?.full_name) ??
    (lang === "es" ? "" : "there");

  // Salutation: "Hola ," looks bad — drop the comma when name is empty.
  const salutationFirstName = firstName || (lang === "es" ? "" : "there");

  // Company name cleanup: strip SEO pipe/dash junk (mirrors generator.ts cleanCompanyName).
  let company = input.prospect.company_name;
  if (company.includes("|")) {
    const parts = company.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) company = parts[parts.length - 1] ?? company;
  } else if (company.includes(" - ") && company.length > 40) {
    const parts = company.split(" - ").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) company = parts[0] ?? company;
  }

  const link = input.deep_pitch_url ?? HUNTER_URL;

  const vars = {
    first_name: salutationFirstName,
    company,
    link,
  };

  const subject = applyVars(tpl.subject, vars);
  const preview_text = applyVars(tpl.preview_text, vars);
  const body = applyVars(tpl.body, vars);

  const industryLabel = lang === "es" ? template.label_es : template.label_en;

  return {
    subject,
    preview_text,
    body,
    pain_id: null,
    case_study_id: null,
    contact_used: contact?.email ?? null,
    measurable_result_included: false,
    // Templates are well-written but not personalized — honest mid-score.
    quality_self_score: 0.35,
    reasoning: `Industry template (${industryLabel}) — Claude unavailable: ${claudeError.slice(0, 150)}. No prospect-specific data; Inefficiency Hunter CTA drives qualification.`,
  };
}
