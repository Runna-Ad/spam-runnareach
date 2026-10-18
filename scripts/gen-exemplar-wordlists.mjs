// Regenerates lib/pitches/wordlists/{en,es}.ts, the exemplar leak check's
// frequency allow-list, from hermitdave/FrequencyWords (CC BY-SA 4.0).
//
//   node scripts/gen-exemplar-wordlists.mjs <dir with en_50k.txt and es_50k.txt> [count]
//
// Download the sources first (each line is "word count"):
//   https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt
//   https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/es/es_50k.txt
// Words are folded (accents dropped, lower case), split on non-letters, and the
// first `count` distinct pieces in frequency order are kept. Pieces with a
// letter outside a-z after folding are left out: the leak check never allows them.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, countArg] = process.argv.slice(2);
if (!dir) throw new Error("usage: node scripts/gen-exemplar-wordlists.mjs <source dir> [count]");
const count = Number(countArg ?? 50000);

const fold = (s) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ł/g, "l").replace(/đ/g, "d").replace(/ø/g, "o");

const LANGS = {
  en: { name: "English", constant: "EN_WORDS" },
  es: { name: "Spanish", constant: "ES_WORDS" },
};

for (const [lang, { name, constant }] of Object.entries(LANGS)) {
  const words = [];
  const seen = new Set();
  for (const line of readFileSync(join(dir, `${lang}_50k.txt`), "utf8").split("\n")) {
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
 * line. Used by the exemplar leak check (lib/pitches/exemplars.ts) as an
 * allow-list: a scrubbed past email may contain only these words, our own
 * vocabulary (./vocab.ts) and blanks.
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
