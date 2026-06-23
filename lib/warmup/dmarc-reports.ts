// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/dmarc-reports.ts
//
// In-house DMARC aggregate-report (RFC 7489) ingestion.
//
// runnareach.com publishes  _dmarc.runnareach.com = v=DMARC1; p=none;
// rua=mailto:pedro@runnareach.com  — so Gmail/Yahoo/Microsoft/etc. already mail
// daily aggregate reports (gzip- or zip-attached XML) INTO pedro@runnareach.com,
// the mailbox we already poll via the Gmail OAuth token (lib/gmail/read.ts).
//
// This module: list those emails via the Gmail API → download each attachment →
// decompress (node:zlib for .gz, a minimal central-directory reader for .zip) →
// parse the XML with fast-xml-parser (NEVER regex on nested <record>) → upsert
// report + per-source records, deduped by report_id.
//
// The low-volume payoff lives in the per-source records: any sending IP claiming
// to be runnareach.com that fails DMARC alignment is potential spoofing/abuse —
// visible here long before Postmaster has any data.
// ─────────────────────────────────────────────────────────────────────────────

import * as zlib from "node:zlib";
import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

const MESSAGES_LIST_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ParsedDmarcRecord = {
  source_ip: string | null;
  message_count: number;
  disposition: string | null;
  dkim_eval: string | null;
  spf_eval: string | null;
  dkim_aligned: boolean | null;
  spf_aligned: boolean | null;
  dmarc_pass: boolean;
  header_from: string | null;
};

export type ParsedDmarcReport = {
  report_id: string;
  org_name: string | null;
  email: string | null;
  date_range_begin: string | null; // ISO
  date_range_end: string | null; // ISO
  policy_domain: string | null;
  policy_p: string | null;
  policy_pct: number | null;
  records: ParsedDmarcRecord[];
};

export type IngestResult = {
  messages_scanned: number;
  reports_parsed: number;
  reports_inserted: number;
  records_inserted: number;
  errors: string[];
};

// ── Gmail attachment fetch helpers ─────────────────────────────────────────────

type GmailPart = {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = { id: string; payload?: GmailPart };

/** Flatten a Gmail payload tree into every part that carries an attachment. */
function collectAttachmentParts(part: GmailPart | undefined, out: GmailPart[]): void {
  if (!part) return;
  if (part.body?.attachmentId && part.filename) out.push(part);
  for (const child of part.parts ?? []) collectAttachmentParts(child, out);
}

function isDmarcAttachment(filename: string): boolean {
  const f = filename.toLowerCase();
  return f.endsWith(".gz") || f.endsWith(".zip") || f.endsWith(".xml") || f.endsWith(".xml.gz");
}

/** Decompress a raw attachment buffer to XML text, by filename hint. */
function decompressToXml(filename: string, buf: Buffer): string {
  const f = filename.toLowerCase();
  if (f.endsWith(".gz")) {
    return zlib.gunzipSync(buf).toString("utf8");
  }
  if (f.endsWith(".zip")) {
    return extractFirstZipEntry(buf).toString("utf8");
  }
  // Plain .xml
  return buf.toString("utf8");
}

// ── Minimal ZIP reader (single XML entry) ──────────────────────────────────────
// DMARC zip attachments contain exactly one XML file. We read the End Of Central
// Directory record, walk to the first central-directory entry, then inflate the
// local file data. Avoids pulling in a zip dependency.

function extractFirstZipEntry(buf: Buffer): Buffer {
  // End of Central Directory signature 0x06054b50, scan from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no EOCD record");

  const cdOffset = buf.readUInt32LE(eocd + 16);
  // Central directory file header signature 0x02014b50.
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("zip: bad central dir");

  const method = buf.readUInt16LE(cdOffset + 10);
  const compressedSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const extraLen = buf.readUInt16LE(cdOffset + 30);
  const commentLen = buf.readUInt16LE(cdOffset + 32);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  void nameLen;
  void extraLen;
  void commentLen;

  // Local file header signature 0x04034b50.
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip: bad local header");
  const localNameLen = buf.readUInt16LE(localOffset + 26);
  const localExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const data = buf.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return Buffer.from(data); // stored
  if (method === 8) return inflateRawSync(data); // deflate
  throw new Error(`zip: unsupported compression method ${method}`);
}

async function listDmarcMessageIds(
  accessToken: string,
  newerThanDays: number,
): Promise<string[]> {
  // DMARC reports always carry an attachment and a recognisable subject/filename.
  const q =
    `has:attachment newer_than:${newerThanDays}d ` +
    `(subject:"Report domain" OR subject:"Report Domain" OR subject:dmarc OR ` +
    `filename:xml OR filename:gz OR filename:zip)`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  // Cap pages so a runaway mailbox can't blow the function budget.
  for (let page = 0; page < 5; page++) {
    const url = new URL(MESSAGES_LIST_URL);
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`messages.list failed (${res.status}): ${body.slice(0, 160)}`);
    }
    const json = (await res.json()) as { messages?: { id: string }[]; nextPageToken?: string };
    for (const m of json.messages ?? []) ids.push(m.id);
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

async function fetchMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const res = await fetch(`${MESSAGES_LIST_URL}/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`messages.get failed (${res.status})`);
  return (await res.json()) as GmailMessage;
}

async function fetchAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await fetch(
    `${MESSAGES_LIST_URL}/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`attachments.get failed (${res.status})`);
  const json = (await res.json()) as { data?: string };
  return Buffer.from(json.data ?? "", "base64url");
}

// ── XML parsing (RFC 7489) ──────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
});

/** Coerce fast-xml-parser's "single child = object, many = array" into an array. */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function epochToIso(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** Parse one aggregate-report XML document into a normalized report. */
export function parseDmarcXml(xml: string): ParsedDmarcReport | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = xmlParser.parse(xml) as any;
  const fb = root?.feedback;
  if (!fb) return null;

  const meta = fb.report_metadata ?? {};
  const reportId = str(meta.report_id);
  if (!reportId) return null;

  const range = meta.date_range ?? {};
  const policy = fb.policy_published ?? {};
  const policyDomain = str(policy.domain);

  const records: ParsedDmarcRecord[] = [];
  for (const rec of asArray(fb.record)) {
    const row = rec?.row ?? {};
    const evaluated = row.policy_evaluated ?? {};
    const identifiers = rec?.identifiers ?? {};
    const auth = rec?.auth_results ?? {};
    const headerFrom = str(identifiers.header_from);

    const dkimEval = str(evaluated.dkim)?.toLowerCase() ?? null;
    const spfEval = str(evaluated.spf)?.toLowerCase() ?? null;

    // Alignment: an auth_results entry whose domain matches header_from and
    // whose result is "pass". policy_evaluated already folds alignment in, but
    // we compute these for richer surfacing.
    const dkimAligned = alignmentPass(asArray(auth.dkim), headerFrom);
    const spfAligned = alignmentPass(asArray(auth.spf), headerFrom);

    // DMARC verdict: policy_evaluated.dkim/spf == "pass" means passed AND aligned.
    const dmarcPass = dkimEval === "pass" || spfEval === "pass";

    records.push({
      source_ip: str(row.source_ip),
      message_count: Number(row.count) || 0,
      disposition: str(evaluated.disposition)?.toLowerCase() ?? null,
      dkim_eval: dkimEval,
      spf_eval: spfEval,
      dkim_aligned: dkimAligned,
      spf_aligned: spfAligned,
      dmarc_pass: dmarcPass,
      header_from: headerFrom,
    });
  }

  return {
    report_id: reportId,
    org_name: str(meta.org_name),
    email: str(meta.email),
    date_range_begin: epochToIso(range.begin),
    date_range_end: epochToIso(range.end),
    policy_domain: policyDomain,
    policy_p: str(policy.p)?.toLowerCase() ?? null,
    policy_pct: policy.pct !== undefined ? Number(policy.pct) || null : null,
    records,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function alignmentPass(entries: any[], headerFrom: string | null): boolean | null {
  if (entries.length === 0) return null;
  if (!headerFrom) return null;
  const hf = headerFrom.toLowerCase();
  for (const e of entries) {
    const dom = str(e?.domain)?.toLowerCase();
    const result = str(e?.result)?.toLowerCase();
    if (result === "pass" && dom && (dom === hf || dom.endsWith(`.${hf}`) || hf.endsWith(`.${dom}`))) {
      return true;
    }
  }
  return false;
}

// ── Top-level ingestion ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

/**
 * Find, parse, and store DMARC aggregate reports for one tenant's mailbox.
 *
 * @param accessToken  a live Gmail OAuth token for the rua= mailbox.
 * @param newerThanDays  how far back to scan (default 14).
 */
export async function ingestDmarcReports(
  supabase: AnySupabase,
  tenantId: string,
  accessToken: string,
  newerThanDays = 14,
): Promise<IngestResult> {
  const result: IngestResult = {
    messages_scanned: 0,
    reports_parsed: 0,
    reports_inserted: 0,
    records_inserted: 0,
    errors: [],
  };

  let ids: string[];
  try {
    ids = await listDmarcMessageIds(accessToken, newerThanDays);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }

  // Dedupe up-front: which report_ids do we already have for this tenant?
  // (We still rely on the UNIQUE constraint, but this skips re-download cost.)
  for (const id of ids) {
    result.messages_scanned += 1;
    try {
      const msg = await fetchMessage(accessToken, id);
      const parts: GmailPart[] = [];
      collectAttachmentParts(msg.payload, parts);
      const dmarcParts = parts.filter((p) => p.filename && isDmarcAttachment(p.filename));
      if (dmarcParts.length === 0) continue;

      for (const part of dmarcParts) {
        const attachmentId = part.body?.attachmentId;
        if (!attachmentId) continue;
        const raw = await fetchAttachment(accessToken, id, attachmentId);
        let xml: string;
        try {
          xml = decompressToXml(part.filename!, raw);
        } catch (e) {
          result.errors.push(`decompress ${part.filename}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }

        const parsed = parseDmarcXml(xml);
        if (!parsed) continue;
        result.reports_parsed += 1;

        const inserted = await upsertReport(supabase, tenantId, id, parsed);
        if (inserted.reportInserted) result.reports_inserted += 1;
        result.records_inserted += inserted.recordsInserted;
      }
    } catch (err) {
      result.errors.push(`msg ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

async function upsertReport(
  supabase: AnySupabase,
  tenantId: string,
  gmailMessageId: string,
  parsed: ParsedDmarcReport,
): Promise<{ reportInserted: boolean; recordsInserted: number }> {
  // Skip if we already have this report (dedupe on tenant_id + report_id).
  const { data: existing } = await supabase
    .from("dmarc_reports")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("report_id", parsed.report_id)
    .maybeSingle();
  if (existing) return { reportInserted: false, recordsInserted: 0 };

  const { data: report, error: repErr } = await supabase
    .from("dmarc_reports")
    .insert({
      tenant_id: tenantId,
      report_id: parsed.report_id,
      org_name: parsed.org_name,
      email: parsed.email,
      date_range_begin: parsed.date_range_begin,
      date_range_end: parsed.date_range_end,
      policy_domain: parsed.policy_domain,
      policy_p: parsed.policy_p,
      policy_pct: parsed.policy_pct,
      gmail_message_id: gmailMessageId,
    })
    .select("id")
    .maybeSingle();

  // Unique-violation race (two ticks): treat as already-present.
  if (repErr || !report) return { reportInserted: false, recordsInserted: 0 };

  if (parsed.records.length > 0) {
    const rows = parsed.records.map((r) => ({
      report_fk: report.id,
      tenant_id: tenantId,
      source_ip: r.source_ip,
      message_count: r.message_count,
      disposition: r.disposition,
      dkim_eval: r.dkim_eval,
      spf_eval: r.spf_eval,
      dkim_aligned: r.dkim_aligned,
      spf_aligned: r.spf_aligned,
      dmarc_pass: r.dmarc_pass,
      header_from: r.header_from,
    }));
    await supabase.from("dmarc_report_records").insert(rows);
  }

  return { reportInserted: true, recordsInserted: parsed.records.length };
}
