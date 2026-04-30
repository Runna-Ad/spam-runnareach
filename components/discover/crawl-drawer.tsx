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

  const [keyword, setKeyword] = React.useState("");
  const [location, setLocation] = React.useState("Canada");
  const [market, setMarket] = React.useState<"CA" | "MX" | "US" | "LATAM">("CA");
  const [pages, setPages] = React.useState("3");
  const [icpId, setIcpId] = React.useState("");
  const [result, setResult] = React.useState<CrawlResult | null>(null);
  const [running, startRun] = React.useTransition();

  // Reset on close
  React.useEffect(() => {
    if (!open) {
      setKeyword("");
      setLocation("Canada");
      setMarket("CA");
      setPages("3");
      setIcpId("");
      setResult(null);
    }
  }, [open]);

  const handleRun = () => {
    if (!keyword.trim()) return;
    setResult(null);
    startRun(async () => {
      const out = await runCrawl({
        source,
        keyword: keyword.trim(),
        location: isYP ? location : undefined,
        market: isYP ? "CA" : market,
        pages: Number(pages),
        icp_id: icpId || null,
      });
      setResult(out);
    });
  };

  const sourceLabel = isYP ? "Yellow Pages CA" : "Brave Search";
  const canSubmit = keyword.trim().length > 0 && !running;

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
              : "Keyword search via Brave Search API. 2,000 free queries/month."}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-5">
          {/* Keyword */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="crawl-keyword">Keyword *</Label>
            <Input
              id="crawl-keyword"
              placeholder={isYP ? 'e.g. "pet food"' : 'e.g. "pet food" shopify canada'}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canSubmit && handleRun()}
            />
            <p className="text-[11px] text-[var(--color-fg-500)]">
              {isYP
                ? "Matches the YP search field — use plain English like a customer would."
                : "Full Brave query string — supports site:, \" \", and other operators."}
            </p>
          </div>

          {/* Location (YP only) */}
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

          {/* Market (Brave only) */}
          {!isYP && (
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
