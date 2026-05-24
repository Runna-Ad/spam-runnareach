"use client";

import { Globe, Loader2, Search } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { runCrawl, type CrawlResult } from "@/lib/discover/crawl-action";
import type { CrawlableSource } from "@/lib/discover/source-meta";

// ── Constants ────────────────────────────────────────────────────────────────

const CA_PROVINCES = [
  { value: "Canada", label: "All Canada" },
  { value: "Alberta", label: "Alberta" },
  { value: "British Columbia", label: "British Columbia" },
  { value: "Manitoba", label: "Manitoba" },
  { value: "New Brunswick", label: "New Brunswick" },
  { value: "Newfoundland and Labrador", label: "Newfoundland and Labrador" },
  { value: "Nova Scotia", label: "Nova Scotia" },
  { value: "Ontario", label: "Ontario" },
  { value: "Prince Edward Island", label: "Prince Edward Island" },
  { value: "Quebec", label: "Quebec" },
  { value: "Saskatchewan", label: "Saskatchewan" },
];

const MX_STATES = [
  { value: "0", label: "Todo México" },
  { value: "09", label: "Ciudad de México" },
  { value: "14", label: "Jalisco" },
  { value: "19", label: "Nuevo León" },
  { value: "15", label: "Estado de México" },
  { value: "21", label: "Puebla" },
  { value: "22", label: "Querétaro" },
  { value: "11", label: "Guanajuato" },
  { value: "26", label: "Sonora" },
  { value: "28", label: "Tamaulipas" },
  { value: "30", label: "Veracruz" },
  { value: "31", label: "Yucatán" },
  { value: "02", label: "Baja California" },
  { value: "25", label: "Sinaloa" },
  { value: "08", label: "Chihuahua" },
];

const PAGES_OPTIONS = [
  { value: "1", label: "1 page (~10 results)" },
  { value: "3", label: "3 pages (~30 results)" },
  { value: "5", label: "5 pages (~50 results)" },
  { value: "10", label: "10 pages (~100 results)" },
];

// ── Props ────────────────────────────────────────────────────────────────────

interface CrawlDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: CrawlableSource;
  icps: { id: string; name: string; market: "CA" | "MX" | "US" | "LATAM" }[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CrawlDrawer({
  open,
  onOpenChange,
  source,
  icps,
}: CrawlDrawerProps) {
  const isYP = source === "yellowpages_ca";
  const isDenue = source === "denue";
  const isYelp = source === "yelp";
  const isGoogle = source === "google_places";

  const [keyword, setKeyword] = React.useState("");
  const [location, setLocation] = React.useState("Canada");
  const [market, setMarket] = React.useState<"CA" | "MX" | "US" | "LATAM">("CA");
  const [pages, setPages] = React.useState("3");
  const [icpId, setIcpId] = React.useState("");
  const [result, setResult] = React.useState<CrawlResult | null>(null);
  const [running, startRun] = React.useTransition();

  // Reset on close — default location depends on source
  React.useEffect(() => {
    if (!open) {
      setKeyword("");
      setLocation(isDenue ? "0" : "Canada");
      setMarket("CA");
      setPages("3");
      setIcpId("");
      setResult(null);
    }
  }, [open, isDenue]);

  // For Yelp + Google Places: auto-update the default location when market changes
  React.useEffect(() => {
    if (isYelp || isGoogle) {
      setLocation(
        market === "MX" ? "Mexico"
        : market === "US" ? "United States"
        : "Canada",
      );
    }
  }, [isYelp, isGoogle, market]);

  const handleRun = () => {
    if (!keyword.trim() && !isDenue) return;
    setResult(null);
    startRun(async () => {
      const out = await runCrawl({
        source,
        keyword: keyword.trim() || "0",
        location: isYP ? location : isDenue ? location : isYelp ? location : isGoogle ? location : undefined,
        market: isYP ? "CA" : isDenue ? "MX" : market,
        pages: Number(pages),
        icp_id: icpId || null,
      });
      setResult(out);
    });
  };

  const sourceLabel =
    isYP ? "Yellow Pages CA"
    : isDenue ? "DENUE México"
    : isYelp ? "Yelp Fusion"
    : isGoogle ? "Google Places"
    : "Brave Search";

  const canSubmit = (isDenue || keyword.trim().length > 0) && !running;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-[var(--color-fg-500)]" aria-hidden />
            Run {sourceLabel} crawl
          </DrawerTitle>
          <DrawerDescription>
            {isYP
              ? "Scrapes yellowpages.ca for matching businesses. Free — no API key needed."
              : isDenue
                ? "Queries INEGI's national business registry — ~5M Mexican businesses, free API."
                : isYelp
                  ? "Searches Yelp's business directory across CA, MX & US. 500 free calls/day. Great for finding SMBs without websites."
                  : isGoogle
                    ? "Searches Google's full business index — returns website URL directly. ~7,000 free calls/month."
                    : "Keyword search via Brave Search API. 2,000 free queries/month."}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-5">
          {/* Keyword */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="crawl-keyword">
              {isDenue ? "Búsqueda (opcional)" : "Keyword *"}
            </Label>
            <Input
              id="crawl-keyword"
              placeholder={
                isYP
                  ? 'e.g. "pet food"'
                  : isDenue
                    ? 'SCIAN code (e.g. "46", "5411") or name (e.g. "restaurante")'
                    : isYelp
                      ? 'e.g. "web design", "restaurants", "pet grooming"'
                      : isGoogle
                        ? 'e.g. "clothing boutique", "pet store", "furniture"'
                        : 'e.g. "pet food" shopify canada'
              }
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canSubmit && handleRun()}
            />
            <p className="text-[11px] text-[var(--color-fg-500)]">
              {isYP
                ? "Matches the YP search field — use plain English like a customer would."
                : isDenue
                  ? "Enter a SCIAN sector code (46 = retail, 54 = professional services) or leave blank to search all industries in the selected state."
                  : isYelp
                    ? "Yelp category or business type — plain English. Returns up to 50 results sorted by popularity."
                    : isGoogle
                      ? "Business type or industry — location is appended automatically. Returns up to 20 results with website URLs."
                      : "Full Brave query string — supports site:, \" \", and other operators."}
            </p>
          </div>

          {/* Location — YP provinces */}
          {isYP && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="crawl-location">Province</Label>
              <Select
                id="crawl-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              >
                {CA_PROVINCES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* Location — DENUE Mexican states */}
          {isDenue && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="crawl-state">Estado</Label>
              <Select
                id="crawl-state"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              >
                {MX_STATES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* Market (Brave + Yelp + Google) */}
          {!isYP && !isDenue && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="crawl-market">Market</Label>
              <Select
                id="crawl-market"
                value={market}
                onChange={(e) =>
                  setMarket(e.target.value as "CA" | "MX" | "US" | "LATAM")
                }
              >
                <option value="CA">Canada (CA)</option>
                <option value="MX">Mexico (MX)</option>
                <option value="US">United States (US)</option>
              </Select>
            </div>
          )}

          {/* Location — Yelp / Google free-text (city, province, or country) */}
          {(isYelp || isGoogle) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="crawl-location-text">Location</Label>
              <Input
                id="crawl-location-text"
                placeholder='e.g. "Alberta, Canada", "Ciudad de México", "Toronto, ON"'
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
              <p className="text-[11px] text-[var(--color-fg-500)]">
                {isGoogle
                  ? "Appended to your keyword query — be as specific or broad as you like."
                  : "City, province, state, or country — Yelp geocodes this automatically."}
              </p>
            </div>
          )}

          {/* Pages (YP only) */}
          {isYP && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="crawl-pages">Depth</Label>
              <Select
                id="crawl-pages"
                value={pages}
                onChange={(e) => setPages(e.target.value)}
              >
                {PAGES_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* ICP */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="crawl-icp">Assign to ICP (optional)</Label>
            <Select
              id="crawl-icp"
              value={icpId}
              onChange={(e) => setIcpId(e.target.value)}
            >
              <option value="">— none —</option>
              {icps.map((icp) => (
                <option key={icp.id} value={icp.id}>
                  {icp.name}
                </option>
              ))}
            </Select>
          </div>

          {/* Result */}
          {result && (
            <div
              className={`rounded-[var(--radius-md)] px-3 py-2 text-sm ${
                result.ok
                  ? "bg-[var(--color-success-950)] text-[var(--color-success-300)]"
                  : "bg-[var(--color-danger-950)] text-[var(--color-danger-300)]"
              }`}
            >
              {result.ok ? (
                <>
                  <p className="font-medium">
                    ✓ {result.candidates_new} new prospect
                    {result.candidates_new === 1 ? "" : "s"} added
                  </p>
                  <p className="mt-0.5 text-[11px] opacity-75">
                    {result.candidates_found} found · {result.candidates_duplicate} duplicate
                    {result.candidates_duplicate === 1 ? "" : "s"} skipped
                    {result.red_flags > 0
                      ? ` · ${result.red_flags} red flag${result.red_flags === 1 ? "" : "s"}`
                      : ""}
                  </p>
                </>
              ) : (
                <p>{result.error}</p>
              )}
            </div>
          )}
        </DrawerBody>

        <DrawerFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            Close
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleRun}
            disabled={!canSubmit}
          >
            {running ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Crawling…
              </>
            ) : (
              <>
                <Search className="h-3.5 w-3.5" aria-hidden />
                Run crawl
              </>
            )}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
