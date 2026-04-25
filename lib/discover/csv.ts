/**
 * Tiny CSV parser. Quoted fields, escaped quotes, CRLF — covers the shape
 * of any spreadsheet export we'll see for manual prospect uploads.
 *
 * Returns header + rows. Header is the first row, lowercased + trimmed.
 */
export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
};

export function parseCsv(input: string): ParsedCsv {
  const cells: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      cells.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  // Flush trailing cell + row.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    cells.push(row);
  }

  if (cells.length === 0) return { headers: [], rows: [] };

  const headers = cells[0]!.map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < cells.length; r++) {
    const raw = cells[r]!;
    if (raw.every((v) => v.trim() === "")) continue; // skip blank lines
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]!] = (raw[c] ?? "").trim();
    }
    rows.push(obj);
  }
  return { headers, rows };
}

export type CsvProspectRow = {
  company_name: string;
  domain: string | null;
  website_url: string | null;
  industry: string | null;
  city: string | null;
  region: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  language?: "en" | "es";
};

export type CsvParseError = { row: number; reason: string };

export type CsvParseResult = {
  rows: CsvProspectRow[];
  errors: CsvParseError[];
  totalRows: number;
};

const REQUIRED_HEADERS = ["company_name", "market"] as const;
const VALID_MARKETS = new Set(["CA", "MX", "US", "LATAM"]);

/**
 * Parse + validate a CSV against the manual-upload schema. Recognized headers:
 *   company_name (required)
 *   market       (required — one of CA, MX, US, LATAM)
 *   domain, website_url, industry, city, region, language (optional)
 *
 * Each malformed row is surfaced as an error rather than rejecting the whole file.
 */
export function parseProspectCsv(input: string): CsvParseResult {
  const { headers, rows } = parseCsv(input);
  const errors: CsvParseError[] = [];

  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) {
      return {
        rows: [],
        errors: [{ row: 0, reason: `Missing required header: ${required}` }],
        totalRows: 0,
      };
    }
  }

  const out: CsvProspectRow[] = [];
  rows.forEach((r, idx) => {
    const lineNo = idx + 2; // +1 for header, +1 for 1-indexed line numbers
    const companyName = r.company_name?.trim();
    const market = r.market?.trim().toUpperCase();
    if (!companyName) {
      errors.push({ row: lineNo, reason: "company_name is empty" });
      return;
    }
    if (!market || !VALID_MARKETS.has(market)) {
      errors.push({
        row: lineNo,
        reason: `market must be one of CA, MX, US, LATAM (got "${market || "—"}")`,
      });
      return;
    }
    out.push({
      company_name: companyName,
      domain: r.domain?.trim() || null,
      website_url: r.website_url?.trim() || null,
      industry: r.industry?.trim() || null,
      city: r.city?.trim() || null,
      region: r.region?.trim() || null,
      market: market as "CA" | "MX" | "US" | "LATAM",
      language: r.language?.trim().toLowerCase() === "es" ? "es" : undefined,
    });
  });

  return { rows: out, errors, totalRows: rows.length };
}
