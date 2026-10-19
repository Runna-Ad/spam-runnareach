// Regenerates the exemplar leak check's word data (lib/pitches/exemplars.ts):
// lib/pitches/wordlists/{en,es}.ts (frequency allow-list) and names.ts (the
// names net). Nothing here runs in the app; the sources are not committed.
//
//   node scripts/gen-exemplar-wordlists.mjs <source dir> [count]
//
// Sources (download into <source dir>):
//   en_50k.txt, es_50k.txt   hermitdave/FrequencyWords, content/2018/{en,es}/{lang}_50k.txt (CC BY-SA 4.0)
//     https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt
//   baby-names.csv           US SSA given names, top 1,000 per year 1880-2008 (public domain)
//     https://raw.githubusercontent.com/hadley/data-baby-names/master/baby-names.csv
//   ssa-all.csv              US SSA given names, every name given to 5+ babies in a year 1880-2017, as
//     "name,total" (public domain; hadley/babynames data/babynames.rda). Only the names that are no
//     word at all are taken from it: the long tail is full of words (Legend, Story, Brand). Convert with
//     `pip install rdata`, then:
//       python3 -c "import rdata,collections,sys;d=rdata.read_rda(sys.argv[1])['babynames'];c=collections.Counter()
//       [c.update({str(n):int(k)}) for n,k in zip(d['name'],d['n'])];open(sys.argv[2],'w').write('name,total\n'+''.join(f'{n},{k}\n' for n,k in c.most_common()))" babynames.rda ssa-all.csv
//     https://raw.githubusercontent.com/hadley/babynames/master/data/babynames.rda
//   surnames.csv             US Census 2000 surnames (public domain)
//     https://raw.githubusercontent.com/fivethirtyeight/data/master/most-common-name/surnames.csv
//   {en_US,en_GB,en_CA,es_MX,es_ES}.{aff,dic}   LibreOffice Hunspell dictionaries, used only to tell
//     which names are also everyday words (affix-aware, through nspell); no dictionary word is copied out.
//     https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_US.aff (and .dic, en_GB, en_CA,
//     es/es_MX, es/es_ES)
//
//   world-cities.csv         GeoNames cities15000 (populated places of 15,000+ and capitals), name, country,
//     subcountry, geonameid; GeoNames data, CC BY 4.0 (https://www.geonames.org/), via datasets/world-cities
//     https://raw.githubusercontent.com/datasets/world-cities/master/data/world-cities.csv
//     Only the Canadian and Mexican rows are used, for lib/pitches/wordlists/places.ts.
//
// nspell (MIT) is a dev-time tool, never a dependency of the app: install it anywhere and point
// NSPELL_DIR at that folder (`npm install --prefix /tmp/nsp nspell@2.1.5`, NSPELL_DIR=/tmp/nsp).
//
// Frequency words are folded (accents dropped, lower case), split on non-letters,
// and the first `count` distinct a-z pieces in frequency order are kept (the leak
// check's strict tier reads the first 20,000 of them, its generous tier all).

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [dir, countArg] = process.argv.slice(2);
if (!dir) throw new Error("usage: node scripts/gen-exemplar-wordlists.mjs <source dir> [count]");
const count = Number(countArg ?? 50000);
/** Census surnames down to this rank: far enough for Okafor, Brar, Chatterjee. */
const SURNAME_RANK = 40000;
/**
 * A name that is also a word counts as a name capitalized mid-sentence only when it is strong: a given
 * name, a surname this common, or a surname at least STRONG_SHARE % Hispanic or Asian (the prospects we
 * pitch in Mexico and Canada; the US rank undercounts them).
 */
const STRONG_SURNAME_RANK = 10000;
const STRONG_SHARE = 50;
/** Long-tail given names (Deepak, Navdeep, Xin) need this many births in all to count. */
const LONG_TAIL_BIRTHS = 200;

const fold = (s) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ł/g, "l").replace(/đ/g, "d").replace(/ø/g, "o");
const read = (f) => readFileSync(join(dir, f), "utf8");
const az = (w) => /^[a-z]{2,}$/.test(w);

const LANGS = {
  en: { name: "English", constant: "EN_WORDS" },
  es: { name: "Spanish", constant: "ES_WORDS" },
};

for (const [lang, { name, constant }] of Object.entries(LANGS)) {
  const words = [];
  const seen = new Set();
  for (const line of read(`${lang}_50k.txt`).split("\n")) {
    const word = line.split(" ")[0] ?? "";
    for (const piece of fold(word).split(/[^\p{L}]+/u)) {
      if (!piece || seen.has(piece) || !/^[a-z]+$/.test(piece)) continue;
      seen.add(piece);
      words.push(piece);
      if (words.length === count) break;
    }
    if (words.length === count) break;
  }
  const header = `/**
 * The ${words.length.toLocaleString("en-US")} most frequent ${name} words, lower-cased and accent-folded, one per
 * line, most frequent first. Used by the exemplar leak check
 * (lib/pitches/exemplars.ts) as an allow-list: the first 20,000 for its strict
 * tier, all of them for lower-case words in a body.
 *
 * Source: hermitdave/FrequencyWords, content/2018/${lang}/${lang}_50k.txt
 * (https://github.com/hermitdave/FrequencyWords), built from OpenSubtitles 2018.
 * Licence of the word data: CC BY-SA 4.0 (the repository's code: MIT).
 * Attribution: Hermit Dave. Derived here by folding accents, splitting on
 * non-letters and keeping the distinct a-z words in frequency order.
 * Regenerate with scripts/gen-exemplar-wordlists.mjs, do not hand-edit.
 */
`;
  writeFileSync(join("lib/pitches/wordlists", `${lang}.ts`), `${header}export const ${constant} = \`\n${words.join("\n")}\n\`;\n`);
  console.log(`${lang}: ${words.length} words`);
}

// ── Names ─────────────────────────────────────────────────────────────────────

const names = new Set();
const strong = new Set();
for (const line of read("baby-names.csv").split("\n").slice(1)) {
  const n = fold((line.split(",")[1] ?? "").replace(/"/g, ""));
  if (!az(n)) continue;
  names.add(n);
  strong.add(n);
}
const givenCount = names.size;
// name,rank,count,prop100k,cum_prop100k,pctwhite,pctblack,pctapi,pctaian,pct2prace,pcthispanic ("(S)" = suppressed).
for (const line of read("surnames.csv").split("\n").slice(1)) {
  const cols = line.split(",");
  const f = fold(cols[0] ?? "");
  const rank = Number(cols[1]);
  if (!az(f) || !(rank <= SURNAME_RANK)) continue;
  names.add(f);
  const share = Math.max(Number(cols[7]) || 0, Number(cols[10]) || 0);
  if (rank <= STRONG_SURNAME_RANK || share >= STRONG_SHARE) strong.add(f);
}

// Is a name also a word? Affix-aware Hunspell (nspell) over EN (US, GB, CA) and ES (MX, ES): "forth",
// "math", "haga", "vea", "cierra" are words. Names come unaccented, so the folded stems of the .dic
// files are checked as well, with plain inflections: "jazmin" (jazmín), "leon" (león), "flores" (flor).
const nspell = createRequire(join(process.env.NSPELL_DIR ?? process.cwd(), "noop.js"))("nspell");
const spellers = ["en_US", "en_GB", "en_CA", "es_MX", "es_ES"].map((d) => nspell(read(`${d}.aff`), read(`${d}.dic`)));
const dict = new Set();
for (const file of ["en_US.dic", "en_GB.dic", "en_CA.dic", "es_MX.dic", "es_ES.dic"]) {
  for (const line of read(file).split("\n").slice(1)) {
    const w = line.split("/")[0]?.trim() ?? "";
    if (w && w === w.toLowerCase() && /^\p{L}+$/u.test(w)) dict.add(fold(w));
  }
}
const wordCache = new Map();
function isWord(n) {
  if (wordCache.has(n)) return wordCache.get(n);
  const c = [n];
  const tail = (end, ...adds) => {
    if (n.endsWith(end) && n.length > end.length + 1) for (const a of adds) c.push(n.slice(0, -end.length) + a);
  };
  tail("s", ""); tail("es", ""); tail("ies", "y"); tail("ed", "", "e"); tail("a", "o"); tail("as", "o", "os");
  const yes = spellers.some((sp) => sp.correct(n)) || c.some((w) => dict.has(w));
  wordCache.set(n, yes);
  return yes;
}
// The long tail of given names: those that are no dictionary word.
const frequent = new Set([...read("en_50k.txt").split("\n").slice(0, 20000), ...read("es_50k.txt").split("\n").slice(0, 20000)].map((l) => fold(l.split(" ")[0] ?? "")));
let longTail = 0;
/** Long-tail names that are frequent words too (Vikram, Divya, but also "per", "taquilla"): names only capitalized mid-sentence. */
const capitalOnly = [];
for (const line of read("ssa-all.csv").split("\n").slice(1)) {
  const [n, total] = line.split(",");
  const f = fold(n ?? "");
  if (Number(total) < LONG_TAIL_BIRTHS || !az(f) || names.has(f)) continue;
  // A frequent word (Vikram and Divya in subtitles; Serge, Pooja, Brand also dictionary words): a name only capitalized.
  if (frequent.has(f)) {
    capitalOnly.push(f);
    continue;
  }
  if (isWord(f)) continue;
  names.add(f);
  strong.add(f);
  longTail++;
}
const all = [...names].sort();
const wordlike = all.filter(isWord);
const weak = wordlike.filter((n) => !strong.has(n));
// A dictionary gap shows here: frequent words that end up names refused even in lower case.
const nameOnly = new Set(all.filter((n) => !isWord(n)));
const gaps = [...frequent].filter((w) => w.length >= 3 && nameOnly.has(w));
console.log(`top-20k words that are NAME_ONLY (${gaps.length}): ${gaps.join(" ")}`);

writeFileSync(
  "lib/pitches/wordlists/names.ts",
  `/**
 * The names net of the exemplar leak check (lib/pitches/exemplars.ts):
 * ${all.length.toLocaleString("en-US")} given names and surnames, folded, one per line, sorted.
 * - Given names (${givenCount.toLocaleString("en-US")}): every name in the US Social Security Administration's
 *   top 1,000 per year, 1880-2008 (public domain; via hadley/data-baby-names).
 * - Long-tail given names (${longTail.toLocaleString("en-US")}): SSA names given to ${LONG_TAIL_BIRTHS}+ babies in all, 1880-2017
 *   (public domain; via hadley/babynames), only those that are no dictionary word
 *   (Navdeep, Xin). Those also among the 20,000 most frequent words are in
 *   NAME_CAPITAL_ONLY (${capitalOnly.length.toLocaleString("en-US")}: Vikram, Divya, but also "per"): a name only
 *   capitalized mid-sentence.
 * - Surnames: the US Census 2000 surname list down to rank ${SURNAME_RANK.toLocaleString("en-US")} (public domain;
 *   via fivethirtyeight/data). It covers Hispanic, Chinese, South Asian and
 *   French-Canadian surnames common in Canada and Mexico as well.
 * NAME_WORDS (${wordlike.length.toLocaleString("en-US")}) is the subset that is also an everyday word (correct
 * for Hunspell, affixes included, in the LibreOffice en_US, en_GB, en_CA, es_MX
 * or es_ES dictionary): "rosa", "price", "will", "flores". Those are allowed in
 * lower case and at a sentence start; every name is refused capitalized
 * mid-sentence, except the NAME_WEAK ones among the 3,000 most frequent words.
 * NAME_WEAK (${weak.length.toLocaleString("en-US")}): word-like names that are neither a given name, nor among the
 * ${STRONG_SURNAME_RANK.toLocaleString("en-US")} most common surnames, nor a surname ${STRONG_SHARE}%+ Hispanic or Asian ("la", "more", "re").
 * Regenerate with scripts/gen-exemplar-wordlists.mjs, do not hand-edit.
 */
export const NAME_LIST = \`
${all.join("\n")}
\`;

export const NAME_WORDS = \`
${wordlike.join("\n")}
\`;

export const NAME_WEAK = \`
${weak.join("\n")}
\`;

export const NAME_CAPITAL_ONLY = \`
${capitalOnly.sort().join("\n")}
\`;
`,
);
console.log(`names: ${all.length} (${givenCount} given, ${longTail} long tail), also words: ${wordlike.length}, weak: ${weak.length}`);

// ── Places ────────────────────────────────────────────────────────────────────

/**
 * By hand: Mexico City's Spanish names (GeoNames has only "Mexico City"), its boroughs and best-known
 * neighbourhoods, Monterrey's and Guadalajara's best-known colonias (cities15000 lists them only in part),
 * and tourist regions and short forms.
 */
const HAND_PLACES = [
  "Ciudad de México", "Cd. de México", "Cd. México", "CDMX", "México D.F.", "Distrito Federal",
  "Cumbres", "San Pedro", "Valle Oriente", "Providencia", "Andares", "Chapultepec", "Colonia Americana", "Zapopan Centro",
  "Cabo", "Playa", "León",
  "Álvaro Obregón", "Azcapotzalco", "Benito Juárez", "Coyoacán", "Cuajimalpa", "Cuauhtémoc", "Gustavo A. Madero",
  "Iztacalco", "Iztapalapa", "Magdalena Contreras", "Miguel Hidalgo", "Milpa Alta", "Tláhuac", "Tlalpan",
  "Venustiano Carranza", "Xochimilco", "Condesa", "Roma Norte", "Roma Sur", "Polanco", "Santa Fe", "Del Valle",
  "Narvarte", "Nápoles", "Escandón", "San Ángel", "Lomas de Chapultepec", "Juárez", "Doctores", "Tlatelolco",
  "Mixcoac", "Pedregal", "Interlomas", "Ciudad Satélite",
  // Tourist regions written as a place (a municipality or coast, not a cities15000 row).
  "Los Cabos", "Riviera Maya", "Riviera Nayarit", "Boca del Río",
];
const placeSingles = new Set();
const placePhrases = new Set();
const placeRows = read("world-cities.csv").split("\n").slice(1).map((l) => l.split(",")).filter((c) => c[1] === "Mexico" || c[1] === "Canada");
/** Official prefixes the everyday name drops: "Santiago de Querétaro" is Querétaro, "Heroica Nogales" Nogales. */
const PLACE_PREFIX = /^(?:santiago de |victoria de |heroica (?:ciudad de )?|ciudad (?:de )?)/;
/**
 * And the official suffixes: "León de los Aldama" is León, "Iguala de la Independencia" Iguala, "Poza Rica
 * de Hidalgo" Poza Rica. Never down to a lone generic word ("Ciudad", "Villa", "San").
 */
const PLACE_SUFFIX = / (?:de|del) .+$/;
const GENERIC_PLACE_HEADS = new Set(["ciudad", "cd", "villa", "san", "santa", "santo", "puerto", "boca", "valle", "nuevo", "nueva",
  "la", "el", "los", "las", "lomas", "colonia", "fraccionamiento", "pueblo", "heroica", "real", "rancho", "ejido", "barrio",
  // Words Mexican subdivisions are named with ("Terrazas del Valle", "Pórticos de San Antonio").
  "terrazas", "porticos", "residencial", "privadas", "hacienda", "haciendas", "paseos", "jardines", "fuentes", "playas",
  "bosques", "praderas", "colinas", "campestre", "arboledas", "villas", "misiones", "rinconada", "balcones", "vistas"]);
/**
 * A short form that is one of the 20,000 most frequent words ("fuentes", "jardines", "playas", "puente")
 * is no place on its own; the full name stays, and hand-listed ones are places (Playa, León).
 */
const top20k = new Set([...read("en_50k.txt").split("\n").slice(0, 20000), ...read("es_50k.txt").split("\n").slice(0, 20000)].map((l) => fold(l.split(" ")[0] ?? "")));
const shortForms = [];
const placeNames = [...placeRows.map((c) => c[0] ?? ""), ...HAND_PLACES].flatMap((raw) => {
  const f = fold(raw).split(/[^\p{L}]+/u).filter(Boolean).join(" ");
  const forms = new Set([f]);
  for (const g of [f, f.replace(PLACE_PREFIX, "")]) {
    forms.add(g);
    const head = g.replace(PLACE_SUFFIX, "");
    const generic = head.split(" ").every((w) => GENERIC_PLACE_HEADS.has(w)) || (!head.includes(" ") && top20k.has(head));
    if (head !== g && !generic) forms.add(head);
  }
  // "Ciudad Victoria" is also written "Cd. Victoria"; "Ciudad de X" also "Cd. X".
  for (const x of [...forms]) {
    if (!x.startsWith("ciudad ")) continue;
    const rest = x.slice("ciudad ".length);
    forms.add(`cd ${rest}`);
    if (rest.startsWith("de ")) forms.add(`cd ${rest.slice(3)}`);
  }
  for (const x of forms) if (x !== f && x) shortForms.push(`${f} → ${x}`);
  return [...forms].filter(Boolean);
});
console.log(`place short forms (${shortForms.length}): ${shortForms.join("; ")}`);
for (const name of placeNames) {
  const ps = name.split(" ");
  if (ps.length === 1 && ps[0].length >= 3 && /^[a-z]+$/.test(ps[0])) placeSingles.add(ps[0]);
  else if (ps.length > 1 && ps.every((p) => /^[a-z]+$/.test(p))) placePhrases.add(ps.join(" "));
}
const singles = [...placeSingles].sort();
// Every always-allowed list, intersected with the places: anything on both is a decision, printed here.
const vocab = readFileSync("lib/pitches/wordlists/vocab.ts", "utf8");
for (const list of ["OWN_VOCABULARY", "OWN_ACRONYMS", "PLATFORMS", "CAPITALIZED_WORDS", "CAPITALIZED_PHRASES"]) {
  const body = vocab.split(`export const ${list}`)[1]?.split("];")[0] ?? "";
  const words = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const both = words.filter((w) => placeSingles.has(w) || placePhrases.has(w));
  console.log(`${list} ∩ places: ${both.join(" ") || "none"}`);
}
const placeWords = singles.filter((p) => spellers.some((sp) => sp.correct(p)));
console.log(`places: ${singles.length} single, ${placePhrases.size} phrases, also words: ${placeWords.join(" ")}`);
writeFileSync(
  "lib/pitches/wordlists/places.ts",
  `/**
 * The places net of the exemplar leak check (lib/pitches/exemplars.ts): Canadian
 * and Mexican populated places, folded. A place the prospect's city field does
 * not name ("en Querétaro", "near Mississauga") still identifies them.
 * Source: GeoNames cities15000 (places of 15,000+ people, and capitals), the
 * ${placeRows.length.toLocaleString("en-US")} Canadian and Mexican rows, via datasets/world-cities. GeoNames data is
 * licensed CC BY 4.0, https://www.geonames.org/ (attribution required); plus
 * Mexico City's boroughs and best-known neighbourhoods, listed by hand in the
 * generator. PLACE_WORDS: the single-word places that are also everyday words
 * ("progreso", "victoria"), allowed in a lower-case subject.
 * Regenerate with scripts/gen-exemplar-wordlists.mjs, do not hand-edit.
 */
export const PLACE_LIST = \`
${singles.join("\n")}
\`;

export const PLACE_WORDS = \`
${placeWords.join("\n")}
\`;

export const PLACE_PHRASES = \`
${[...placePhrases].sort().join("\n")}
\`;
`,
);
