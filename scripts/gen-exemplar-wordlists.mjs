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
//     "name,total" (public domain; hadley/babynames data/babynames.rda, converted with Python's rdata:
//     https://raw.githubusercontent.com/hadley/babynames/master/data/babynames.rda). Only the names that
//     are no word at all are taken from it: the long tail is full of words (Legend, Story, Brand).
//   surnames.csv             US Census 2000 surnames (public domain)
//     https://raw.githubusercontent.com/fivethirtyeight/data/master/most-common-name/surnames.csv
//   en_US.dic, es_MX.dic     LibreOffice Hunspell dictionaries, used only to tell
//     which names are also everyday words; no dictionary word is copied out.
//     https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_US.dic
//     https://raw.githubusercontent.com/LibreOffice/dictionaries/master/es/es_MX.dic
//
// Frequency words are folded (accents dropped, lower case), split on non-letters,
// and the first `count` distinct a-z pieces in frequency order are kept (the leak
// check's strict tier reads the first 20,000 of them, its generous tier all).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, countArg] = process.argv.slice(2);
if (!dir) throw new Error("usage: node scripts/gen-exemplar-wordlists.mjs <source dir> [count]");
const count = Number(countArg ?? 50000);
/** Census surnames down to this rank: far enough for Okafor, Brar, Chatterjee. */
const SURNAME_RANK = 40000;
/** A name that is also a word counts as a name capitalized mid-sentence only when it is this common a surname, or a given name. */
const STRONG_SURNAME_RANK = 10000;
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
for (const line of read("surnames.csv").split("\n").slice(1)) {
  const [n, rank] = line.split(",");
  const f = fold(n ?? "");
  if (Number(rank) <= SURNAME_RANK && az(f)) names.add(f);
  if (Number(rank) <= STRONG_SURNAME_RANK && az(f)) strong.add(f);
}

/** Lower-case dictionary entries (stems before Hunspell affixes), folded. */
const dict = new Set();
for (const file of ["en_US.dic", "es_MX.dic"]) {
  for (const line of read(file).split("\n").slice(1)) {
    const w = line.split("/")[0]?.trim() ?? "";
    if (w && w === w.toLowerCase() && /^\p{L}+$/u.test(w)) dict.add(fold(w));
  }
}
/** A name is also a word when it, or a plain inflection of it, is a lower-case entry: flores → flor, acosta → acostar, fried → fry. */
function isWord(n) {
  const c = [n];
  const tail = (end, ...adds) => {
    if (n.endsWith(end) && n.length > end.length + 1) for (const a of adds) c.push(n.slice(0, -end.length) + a);
  };
  tail("s", ""); tail("es", ""); tail("ies", "y"); tail("ied", "y"); tail("ed", "", "e"); tail("ing", "", "e");
  tail("er", "", "e"); tail("ers", "", "e"); tail("ly", "");
  tail("a", "o", "ar"); tail("as", "o", "os", "ar"); tail("o", "ar"); tail("e", "ar", "er", "ir"); tail("an", "ar");
  tail("en", "er", "ir"); tail("ado", "ar"); tail("ada", "ar"); tail("ido", "er", "ir"); tail("ida", "er", "ir");
  return c.some((w) => dict.has(w));
}
// The long tail of given names: those that are no dictionary word.
const frequent = new Set([...read("en_50k.txt").split("\n").slice(0, 20000), ...read("es_50k.txt").split("\n").slice(0, 20000)].map((l) => fold(l.split(" ")[0] ?? "")));
let longTail = 0;
/** Long-tail names that are frequent words too (Vikram, Divya, but also "per", "taquilla"): names only capitalized mid-sentence. */
const capitalOnly = [];
for (const line of read("ssa-all.csv").split("\n").slice(1)) {
  const [n, total] = line.split(",");
  const f = fold(n ?? "");
  if (Number(total) < LONG_TAIL_BIRTHS || !az(f) || names.has(f) || isWord(f)) continue;
  if (frequent.has(f)) {
    capitalOnly.push(f);
    continue;
  }
  names.add(f);
  strong.add(f);
  longTail++;
}
const all = [...names].sort();
const wordlike = all.filter(isWord);
const weak = wordlike.filter((n) => !strong.has(n));

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
 * NAME_WORDS (${wordlike.length.toLocaleString("en-US")}) is the subset that is also an everyday word (a lower-case
 * entry, or a plain inflection of one, in the LibreOffice en_US or es_MX
 * Hunspell dictionary): "rosa", "price", "will", "flores". Those are allowed in
 * lower case and at a sentence start; every name is refused capitalized
 * mid-sentence, except NAME_WEAK (${weak.length.toLocaleString("en-US")}): word-like names that are neither a
 * given name nor among the ${STRONG_SURNAME_RANK.toLocaleString("en-US")} most common surnames ("la", "more", "re").
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
