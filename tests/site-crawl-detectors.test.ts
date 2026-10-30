/**
 * Site-crawl detectors (lib/research/site-crawl/detectors.ts) on REAL pages
 * saved from the 2026-10-30 study (tests/fixtures/site-crawl/*.html.gz, bytes as
 * served, gzipped to keep the repo small; the first line is the URL), plus
 * small synthetic pages for the edge rules.
 *
 * The rule under test everywhere: found=false only when every page read was
 * readable; a JavaScript-drawn page gives null, never false.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  absent,
  BOOK_TEXT,
  detectBooking,
  detectContactForm,
  detectCopyrightYear,
  detectEcommerce,
  detectLanguages,
  detectMailto,
  cleanHref,
  runDetectors,
  unseenChecks,
  type CrawledPage,
} from "../lib/research/site-crawl/detectors.ts";
import { parsePage, readableOf } from "../lib/research/site-crawl/parse.ts";
import type { Check, SiteChecks } from "../lib/research/site-crawl/types.ts";

const NOW = new Date("2026-10-30T12:00:00Z");

function fixture(name: string): CrawledPage {
  const raw = gunzipSync(readFileSync(new URL(`./fixtures/site-crawl/${name}.html.gz`, import.meta.url))).toString("utf8");
  const url = /<!-- (https?:\S+) -->/.exec(raw)?.[1];
  assert.ok(url, `${name}: first line names the URL`);
  const parsed = parsePage(raw, url);
  return { url, readable: readableOf(parsed), parsed };
}

function page(url: string, body: string, head = ""): CrawledPage {
  const parsed = parsePage(`<html lang="en"><head>${head}</head><body>${body}</body></html>`, url);
  return { url, readable: readableOf(parsed), parsed };
}

const FILLER = `<p>${"We are a family business serving the valley since 1998. ".repeat(6)}</p>`;
const NAV = `<a href="/about">About</a><a href="/services">Services</a><a href="/gallery">Gallery</a>`;
const failed = (url: string): CrawledPage => ({ url, readable: { html: false, text: false, links: false }, parsed: null });

const checks = (pages: CrawledPage[]) => runDetectors(pages, pages[0]?.url ?? "https://x.test/", NOW);
const allChecks = (c: SiteChecks): Array<[string, Check]> => Object.entries(c) as Array<[string, Check]>;

// ── The three study cases the brief names ────────────────────────────────────

test("study: the hotel's BOOK NOW → reservations.travelclick.com is booking found, external engine", () => {
  const c = checks([fixture("sundial-home")]);
  assert.equal(c.booking.found, true);
  assert.equal(c.booking.channel, "external_engine");
  const first = c.booking.evidence[0];
  assert.ok(first?.href?.startsWith("https://reservations.travelclick.com/"), JSON.stringify(first));
  assert.equal(first?.text, "BOOK NOW");
  assert.equal(first?.url, "https://www.sundialhotel.com/");
});

test("study: the dental clinic whose 'Agendar cita' goes only to wa.me is booking via WhatsApp, not online", () => {
  const c = checks([fixture("omdental-home")]);
  assert.equal(c.booking.channel, "whatsapp");
  assert.equal(c.booking.found, false, "no online booking, and the page was readable");
  assert.ok(c.booking.evidence.some((e) => e.text === "Agendar cita" && e.href?.startsWith("https://wa.me/")));
  assert.equal(c.chat.found, true);
  assert.ok(c.chat.values.includes("WhatsApp"));
});

test("study: a JavaScript-drawn page (Wix shell, body empty) is 'could not see' for booking and every link/text check, never false", () => {
  const shell = fixture("wix-shell");
  assert.deepEqual(shell.readable, { html: true, text: false, links: false });
  const c = checks([shell]);
  assert.equal(c.booking.found, null);
  for (const [name, check] of allChecks(c)) assert.notEqual(check.found, false, `${name} must not claim an absence on a JS page`);
  // What the <head> does show is still seen.
  assert.equal(c.builder.value, "Wix");
  assert.equal(c.mobile_viewport.found, true);
});

test("the same Wix lodge, server-rendered as our crawler got it: 'Book Now' → secure.webrez.com is an external engine", () => {
  const c = checks([fixture("hiddenacres-home")]);
  assert.equal(c.booking.found, true);
  assert.equal(c.booking.channel, "external_engine");
  assert.ok(c.booking.evidence.some((e) => e.href === "https://secure.webrez.com/hotel/3530"));
  // Wix loads its store bundle on every site: not a shop.
  assert.equal(c.ecommerce.found, false);
});

// ── More real pages ──────────────────────────────────────────────────────────

test("a lodge with no booking link at all, readable: booking false", () => {
  const c = checks([fixture("firvale-home")]);
  assert.equal(c.booking.found, false);
  assert.equal(c.booking.channel, null);
  assert.equal(c.builder.value, "WordPress");
  assert.equal(c.jsonld_opening_hours.found, true);
});

test("a place name ('Reserva Real', 'Arava Reserve') is not a booking link; the coarse check still says 'could not see', never false", () => {
  const c = checks([fixture("frava-home")]);
  assert.equal(c.booking.found, null);
  assert.equal(c.booking.channel, null, "not resolved as on-site booking");
  assert.equal(c.copyright_year.year, 2026);
});

test("a booking widget loaded from a known engine (checkfront script) is booking found", () => {
  const c = checks([fixture("strathcona-guest")]);
  assert.equal(c.booking.channel, "external_engine");
  assert.ok(c.booking.evidence.some((e) => e.href?.includes("checkfront.com")));
  // A tag manager can load a chat widget we can't see: chat is null, not false.
  assert.equal(c.chat.found, null);
  assert.ok(c.analytics.values.includes("Google Tag Manager"));
});

test("contact form, JSON-LD, copyright year and builder on a real lodge page", () => {
  const c = checks([fixture("whitemoose-home")]);
  assert.equal(c.contact_form.found, true);
  assert.equal(c.contact_form.fields, 4);
  assert.equal(c.copyright_year.year, 2024);
  assert.equal(c.builder.value, "WordPress");
  assert.ok(c.jsonld.values.includes("Organization"));
});

test("a Shopify product page is ecommerce, with the cart text as evidence", () => {
  const c = checks([fixture("hualiz-product")]);
  assert.equal(c.ecommerce.found, true);
  assert.ok(c.ecommerce.evidence.some((e) => e.text === "Agregar al carrito"));
  assert.equal(c.builder.value, "Shopify");
});

test("JSON-LD aggregateRating is read with its evidence (hotel)", () => {
  const c = checks([fixture("sundial-home")]);
  assert.equal(c.jsonld_rating.found, true);
  assert.equal(c.jsonld_rating.value, 4.6);
  assert.ok(c.jsonld.values.includes("Hotel"));
  assert.equal(c.builder.value, "Squarespace");
  assert.equal(c.ecommerce.found, false, "Squarespace draws a /cart icon on every site");
});

// ── The absence rule ─────────────────────────────────────────────────────────

test("absent(): one unreadable page (failed, JS-drawn or cut by the budget) turns every absence into null", () => {
  const ok = fixture("firvale-home");
  assert.equal(absent([ok], ["html", "links"]), true);
  assert.equal(absent([ok, failed("https://firvalewildernesscamp.com/book/")], ["html", "links"]), false);
  assert.equal(absent([], ["html"]), false, "no page read is never 'absent'");
  const c = checks([ok, failed("https://firvalewildernesscamp.com/book/")]);
  assert.equal(c.booking.found, null);
  for (const [name, check] of allChecks(c)) assert.notEqual(check.found, false, name);
  // What WAS seen is still true.
  assert.equal(c.social.found, true);
});

test("property: on any mix of real pages with one unreadable page, no check says false", () => {
  const names = ["sundial-home", "omdental-home", "hiddenacres-home", "firvale-home", "frava-home", "whitemoose-home", "hualiz-product", "strathcona-guest", "hotelzed-home"];
  const loaded = names.map(fixture);
  for (const a of loaded) {
    for (const bad of [failed(`${a.url}x`), fixture("wix-shell")]) {
      const c = runDetectors([a, bad], a.url, NOW);
      for (const [name, check] of allChecks(c)) assert.notEqual(check.found, false, `${a.url} + unreadable: ${name}`);
    }
  }
});

test("an unreachable site: every check null with no evidence", () => {
  for (const [name, check] of allChecks(unseenChecks())) {
    assert.equal(check.found, null, name);
    assert.deepEqual(check.evidence, [], name);
  }
});

// ── Booking rules (synthetic) ────────────────────────────────────────────────

test("booking text: rights-reserved lines, event agendas and place names are not booking; real asks are", () => {
  for (const no of ["Todos los derechos reservados", "Explore CapU Squamish Agenda", "Arava Reserve", "Reserva Real", "Facebook"]) {
    assert.equal(BOOK_TEXT.test(no), false, no);
  }
  for (const yes of ["Book now", "BOOK YOUR STAY", "Reservar", "Reservaciones", "Agendar cita", "Agenda tu visita", "Réserver", "Book an appointment", "Reserve now", "Reserva ahora"]) {
    assert.equal(BOOK_TEXT.test(yes), true, yes);
  }
});

test("booking: an OTA homepage link is not their listing; a listing URL is a marketplace", () => {
  const home = page("https://lodge.test/", `${FILLER}${NAV}<a href="https://www.booking.com/index.en-gb.html">Booking.com</a><a href="https://www.airbnb.ca/">Airbnb</a>`);
  assert.equal(detectBooking([home], home.url).found, false);
  const listing = page("https://lodge.test/", `${FILLER}${NAV}<a href="https://www.booking.com/hotel/ca/lodge.html">Book on Booking.com</a>`);
  assert.deepEqual([detectBooking([listing], listing.url).found, detectBooking([listing], listing.url).channel], [true, "marketplace"]);
});

test("booking: an engine's own home page ('Powered by') is not a booking link", () => {
  const p = page("https://shop.test/", `${FILLER}${NAV}<a href="https://www.checkfront.com/">Powered by Checkfront</a>`);
  assert.equal(detectBooking([p], p.url).found, false);
});

test("booking: 'Book a consultation' → their /contact page is a request form, not online booking, and not a proven absence", () => {
  const p = page("https://consult.test/", `${FILLER}${NAV}<a href="/contacto">Agenda una asesoría</a>`);
  const b = detectBooking([p], p.url);
  assert.deepEqual([b.online, b.channel], [null, null]);
  assert.equal(b.evidence[0]?.href, "https://consult.test/contacto");
});

test("booking: on-site anchors and pages count; 'Call to book' → tel: is phone-only", () => {
  const anchor = page("https://bnb.test/", `${FILLER}${NAV}<a href="#booknow">Book your stay</a>`);
  assert.deepEqual([detectBooking([anchor], anchor.url).found, detectBooking([anchor], anchor.url).channel], [true, "on_site"]);
  const phone = page("https://bnb.test/", `${FILLER}${NAV}<a href="tel:+12505551234">Call to book</a>`);
  const b = detectBooking([phone], phone.url);
  assert.deepEqual([b.found, b.channel], [false, "phone"]);
  assert.equal(b.evidence[0]?.href, "tel:+12505551234");
});

test("booking: a WhatsApp link whose prefilled text asks for a cita is booking via WhatsApp", () => {
  const p = page("https://clinica.test/", `${FILLER}${NAV}<a href="https://wa.me/5215555555555?text=Hola%2C%20quiero%20agendar%20una%20cita">Escríbenos</a>`);
  assert.equal(detectBooking([p], p.url).channel, "whatsapp");
});

test("booking: a same-site link that redirects to an engine (stub page from the crawl) is external", () => {
  const stub: CrawledPage = {
    url: "https://bnb.test/book",
    readable: { html: true, text: true, links: true },
    parsed: { ...parsePage("<html></html>", "https://bnb.test/book"), links: [{ href: "https://bnb.resnexus.com/resnexus/reservations/book/ABC", text: "booking link (redirects)", fragment: false }] },
  };
  const home = page("https://bnb.test/", `${FILLER}${NAV}`);
  assert.equal(detectBooking([home, stub], home.url).channel, "external_engine");
});

// ── Other rules (synthetic) ──────────────────────────────────────────────────

test("contact form: a search box or a newsletter email field is not a contact form; embedded form tools are", () => {
  const search = page("https://x.test/", `${FILLER}${NAV}<form role="search"><input name="s"></form><form><input type="email" name="newsletter"></form>`);
  assert.equal(detectContactForm([search]).found, false);
  const embed = page("https://x.test/", `${FILLER}${NAV}<iframe src="https://form.jotform.com/12345"></iframe>`);
  const f = detectContactForm([embed]);
  assert.deepEqual([f.found, f.fields], [true, null]);
});

test("copyright: a © whose year is drawn by a script is 'could not see', not 'no year'", () => {
  const p = page("https://x.test/", `${FILLER}${NAV}<footer>© <script>document.write(new Date().getFullYear())</script> Lodge Inc.</footer>`);
  const c = detectCopyrightYear([p], NOW);
  assert.deepEqual([c.found, c.year], [null, null]);
  const ranged = page("https://x.test/", `${FILLER}${NAV}<footer>Copyright 2015-2022 Lodge Inc.</footer>`);
  assert.equal(detectCopyrightYear([ranged], NOW).year, 2022);
});

test("ecommerce: a bare /cart link or a Wix store bundle is not a shop; add-to-cart text is", () => {
  const icon = page("https://x.test/", `${FILLER}${NAV}<a href="/cart">0</a><script src="https://static.parastorage.com/wixstores/app.js"></script>`);
  assert.equal(detectEcommerce([icon], icon.url).found, false);
  const shop = page("https://x.test/", `${FILLER}${NAV}<button>Add to cart</button>`);
  assert.equal(detectEcommerce([shop], shop.url).found, true);
});

test("ecommerce: shop words in free page text alone ('gift shop now open') are not a store", () => {
  const p = page("https://lodge.test/", `${FILLER}${NAV}<p>Our gift shop now open daily. Shop now for local crafts at the front desk.</p>`);
  assert.equal(detectEcommerce([p], p.url).found, false);
  const cart = page("https://shop.test/", `${FILLER}${NAV}<a href="/cart">Cart (0)</a>`);
  assert.equal(detectEcommerce([cart], cart.url).found, true, "a cart link that says so");
});

// ── Booking forms and buttons (review 2026-10-30: Hotel Zed) ─────────────────

test("Hotel Zed: 'Book Now' submits an availability form to reservations.hotelzed.com: booking online, external engine, strong; not a contact form", () => {
  const c = checks([fixture("hotelzed-home")]);
  assert.equal(c.booking.online, true);
  assert.equal(c.booking.found, true);
  assert.equal(c.booking.channel, "external_engine");
  assert.equal(c.booking.strength, "strong");
  assert.ok(c.booking.evidence.some((e) => e.href?.startsWith("https://www.reservations.hotelzed.com/ibe/")), JSON.stringify(c.booking.evidence));
  assert.equal(c.contact_form.found, false, "the availability form is a booking form");
});

test("booking: a form posting to a known engine with date fields is external; onclick / data-href buttons count like links", () => {
  const form = page(
    "https://hotel.test/",
    `${FILLER}${NAV}<form action="https://be.synxis.com/"><input name="arrive" type="date"><input name="depart" type="date"><select name="adults"><option>2</option></select><button type="submit">Check rates</button></form>`,
  );
  const f = detectBooking([form], form.url);
  assert.deepEqual([f.online, f.channel, f.strength], [true, "external_engine", "strong"]);
  assert.equal(detectContactForm([form]).found, false);

  const click = page("https://hotel.test/", `${FILLER}${NAV}<button onclick="window.open('https://reservations.travelclick.com/12345')">BOOK NOW</button>`);
  const b = detectBooking([click], click.url);
  assert.deepEqual([b.online, b.channel], [true, "external_engine"]);
  assert.equal(b.evidence[0]?.href, "https://reservations.travelclick.com/12345");

  const data = page("https://spa.test/", `${FILLER}${NAV}<div data-href="https://spa.janeapp.com/locations/main/book">Book an appointment</div>`);
  assert.equal(detectBooking([data], data.url).channel, "external_engine");
});

test("booking: an on-site form with stay dates and a booking submit is on_site, strong", () => {
  const p = page("https://bnb.test/", `${FILLER}${NAV}<form action="/availability"><input name="checkin"><input name="checkout"><button>Check availability</button></form>`);
  const b = detectBooking([p], p.url);
  assert.deepEqual([b.online, b.channel, b.strength], [true, "on_site", "strong"]);
});

test("fail-closed: a 'Book now' button or text that leads nowhere we can follow is 'could not see', never false", () => {
  const button = page("https://hotel.test/", `${FILLER}${NAV}<button class="open-widget">Book now</button>`);
  assert.equal(detectBooking([button], button.url).online, null);
  const text = page("https://hotel.test/", `${FILLER}${NAV}<p>Reservations are handled by our partner, check availability on the widget.</p>`);
  assert.equal(detectBooking([text], text.url).online, null);
  // Words that merely contain a booking word do not count (study 2026-10-30: these made 6 sites null).
  for (const label of ["Hunting Books & Maps", "Lower Textbook Costs", "Dried, Preserved or Pickled", "Centros de Cursos de Capacitación", "Solicitar evaluación sin costo", "Platypus Hoser Reservoir"]) {
    const p = page("https://shop.test/", `${FILLER}${NAV}<a href="/x/">${label}</a>`);
    assert.equal(detectBooking([p], p.url).online, false, label);
  }
  // Words that merely contain "book" do not count.
  const guest = page("https://lodge.test/", `${FILLER}${NAV}<a href="/guestbook/">Guestbook</a><a href="https://facebook.com/lodge">Facebook</a>`);
  assert.equal(detectBooking([guest], guest.url).online, false);
});

test("a contact form with a 'department' select and no message box is still a contact form (date words are whole words)", () => {
  const p = page(
    "https://firm.test/",
    `${FILLER}${NAV}<form action="/contact/"><input name="name"><input type="email" name="email"><input type="tel" name="tel"><select name="department"><option>Sales</option></select><button type="submit">Send</button></form>`,
  );
  const f = detectContactForm([p], p.url);
  assert.deepEqual([f.found, f.fields], [true, 4]);
  assert.equal(detectBooking([p], p.url).online, false);
});

test("a contact form that only looks like a booking form (date field, no message box) stays a contact form when booking did not resolve from it", () => {
  const p = page("https://firm.test/", `${FILLER}${NAV}<form action="/contacto/"><input name="nombre"><input type="email" name="correo"><input type="date" name="fecha"><button>Enviar</button></form>`);
  assert.equal(detectContactForm([p], p.url).found, true);
});

test("a booking-word link whose target page we read in full, with no booking path on it, is explained: a readable absence, not null", () => {
  const home = page("https://homes.test/", `${FILLER}${NAV}<a href="/desarrollo/21/arava-reserve">Nuevo desarrollo ARAVA RESERVE</a>`);
  const target = page("https://homes.test/desarrollo/21/arava-reserve", `${FILLER}${NAV}<p>Casas de 3 recámaras.</p>`);
  assert.equal(detectBooking([home, target], home.url).online, false);
  // Not crawled: still could not see.
  assert.equal(detectBooking([home], home.url).online, null);
  // Crawled but unreadable: still could not see.
  const shell: CrawledPage = { url: target.url, readable: { html: true, text: false, links: false }, parsed: target.parsed };
  assert.equal(detectBooking([home, shell], home.url).online, null);
});

test("negated booking text ('no reservations needed', 'walk-ins welcome', 'sin cita', 'drop-in appointments') is not a booking signal", () => {
  for (const t of ["No reservations needed, walk-ins welcome.", "Atención sin cita, de lunes a viernes.", "No se requiere reservación.", "Drop-in appointments every Tuesday.", "Appointments are not required."]) {
    const p = page("https://x.test/", `${FILLER}${NAV}<p>${t}</p>`);
    assert.equal(detectBooking([p], p.url).online, false, t);
  }
  const p = page("https://x.test/", `${FILLER}${NAV}<p>Reservations recommended on weekends.</p>`);
  assert.equal(detectBooking([p], p.url).online, null, "a real mention with no path stays could-not-see");
});

test("booking strength: an on-page #booknow anchor is weak; a booking page link is strong", () => {
  const anchor = page("https://bnb.test/", `${FILLER}${NAV}<a href="#booknow">Book your stay</a>`);
  assert.equal(detectBooking([anchor], anchor.url).strength, "weak");
  const pageLink = page("https://bnb.test/", `${FILLER}${NAV}<a href="/reservations/">Reservations</a>`);
  assert.equal(detectBooking([pageLink], pageLink.url).strength, "strong");
});

// ── Evidence hygiene, mail ───────────────────────────────────────────────────

test("evidence hrefs lose tracking parameters (utm_*, _ga, _gac, fbclid, gclid) and keep the rest", () => {
  assert.equal(
    cleanHref("https://reservations.travelclick.com/103668?_ga=2.1&_gac=1.2&utm_source=x&utm_medium=y&fbclid=abc&gclid=def&hotel=7#/rooms"),
    "https://reservations.travelclick.com/103668?hotel=7#/rooms",
  );
  assert.equal(cleanHref("tel:+12505551234"), "tel:+12505551234");
  const c = checks([fixture("sundial-home")]);
  for (const [name, check] of allChecks(c)) {
    for (const e of check.evidence) assert.doesNotMatch(e.href ?? "", /[?&](utm_|_ga=|_gac=|fbclid=|gclid=)/, name);
  }
});

test("mailto: a Cloudflare-protected email link counts as a mailto link", () => {
  const p = page("https://x.test/", `${FILLER}${NAV}<a href="/cdn-cgi/l/email-protection#a1c8cfc7cee1d9d5c4d2d58fc2ce">[email&#160;protected]</a>`);
  assert.equal(detectMailto([p]).found, true);
});

test("languages: html lang + hreflang + a switcher link; one language on a readable site is false", () => {
  const multi = page("https://x.test/", `${FILLER}${NAV}<a href="/es/">Español</a>`, `<link rel="alternate" hreflang="fr-ca" href="https://x.test/fr/">`);
  const l = detectLanguages([multi], multi.url);
  assert.equal(l.found, true);
  assert.deepEqual(l.values.sort(), ["en", "es", "fr"]);
  const one = page("https://x.test/", `${FILLER}${NAV}`);
  assert.deepEqual([detectLanguages([one], one.url).found, detectLanguages([one], one.url).values], [false, ["en"]]);
});

test("every check carries the page URL in each evidence item", () => {
  for (const name of ["sundial-home", "omdental-home", "whitemoose-home", "hualiz-product"]) {
    const p = fixture(name);
    for (const [check, c] of allChecks(checks([p]))) {
      for (const e of c.evidence) assert.ok(e.url.startsWith("http"), `${name} ${check}`);
      assert.ok(c.evidence.length <= 5, `${name} ${check}: evidence capped`);
    }
  }
});
