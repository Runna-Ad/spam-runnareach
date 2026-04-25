"use client";

import { AlertTriangle, FileUp, Loader2, Upload } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { parseProspectCsv, type CsvProspectRow } from "@/lib/discover/csv";
import { uploadProspects } from "@/lib/discover/upload-actions";
import { cn } from "@/lib/utils";

interface IcpOption {
  id: string;
  name: string;
  market: "CA" | "MX" | "US" | "LATAM";
}

interface CsvUploadDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icps: IcpOption[];
}

export function CsvUploadDrawer({ open, onOpenChange, icps }: CsvUploadDrawerProps) {
  const [icpId, setIcpId] = React.useState<string>("");
  const [parsed, setParsed] = React.useState<{
    rows: CsvProspectRow[];
    errors: { row: number; reason: string }[];
    totalRows: number;
    fileName: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    candidates_found: number;
    candidates_new: number;
    candidates_duplicate: number;
  } | null>(null);
  const [uploading, startUpload] = React.useTransition();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) {
      setParsed(null);
      setError(null);
      setResult(null);
      setIcpId("");
    }
  }, [open]);

  const handleFile = (file: File) => {
    setError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const out = parseProspectCsv(text);
      setParsed({ ...out, fileName: file.name });
    };
    reader.onerror = () => setError("Could not read the file.");
    reader.readAsText(file);
  };

  const handleUpload = () => {
    if (!parsed || parsed.rows.length === 0) return;
    setError(null);
    startUpload(async () => {
      const out = await uploadProspects({
        icp_id: icpId || null,
        rows: parsed.rows,
      });
      if (out.ok) {
        setResult({
          candidates_found: out.candidates_found,
          candidates_new: out.candidates_new,
          candidates_duplicate: out.candidates_duplicate,
        });
      } else {
        setError(out.error);
      }
    });
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Upload prospects from CSV</DrawerTitle>
          <DrawerDescription>
            Required headers: <code className="font-mono">company_name</code>,{" "}
            <code className="font-mono">market</code>. Optional:{" "}
            <code className="font-mono">domain, website_url, industry, city, region, language</code>.
            Up to 500 rows per upload. Dedupe runs on normalized domain.
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>ICP (optional)</Label>
              <Select value={icpId} onChange={(e) => setIcpId(e.target.value)}>
                <option value="">— Don't tag with ICP —</option>
                {icps.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.market})
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-[var(--color-fg-700)]">
                If set, all uploaded prospects are tagged with this ICP for downstream filtering.
              </p>
            </div>

            <div
              className={cn(
                "flex flex-col items-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed border-[var(--color-border-default)]",
                "bg-[var(--color-bg-900)] px-6 py-10 text-center",
                "hover:border-[var(--color-accent-300)] hover:bg-[var(--color-bg-700)]",
                "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
              )}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
            >
              <FileUp className="h-6 w-6 text-[var(--color-fg-500)]" aria-hidden />
              <p className="text-xs text-[var(--color-fg-300)]">
                Drop a .csv here, or click to choose a file
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden /> Choose CSV
              </Button>
              {parsed ? (
                <p className="font-mono text-[11px] text-[var(--color-fg-500)]">
                  {parsed.fileName}
                </p>
              ) : null}
            </div>

            {parsed ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <Chip tone="success">{parsed.rows.length} valid</Chip>
                  {parsed.errors.length > 0 ? (
                    <Chip tone="danger">{parsed.errors.length} errors</Chip>
                  ) : null}
                  <span className="text-[var(--color-fg-500)]">
                    of {parsed.totalRows} rows
                  </span>
                </div>

                {parsed.errors.length > 0 ? (
                  <div className="rounded-[var(--radius-md)] bg-[color-mix(in_oklab,var(--color-danger-500),transparent_88%)] p-3 ring-1 ring-inset ring-[color-mix(in_oklab,var(--color-danger-500),transparent_70%)]">
                    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-danger-300)]">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Row errors
                    </div>
                    <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[11px] text-[var(--color-fg-300)]">
                      {parsed.errors.slice(0, 12).map((e, i) => (
                        <li key={i} className="font-mono">
                          line {e.row}: {e.reason}
                        </li>
                      ))}
                      {parsed.errors.length > 12 ? (
                        <li className="italic text-[var(--color-fg-700)]">
                          + {parsed.errors.length - 12} more
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ) : null}

                {parsed.rows.length > 0 ? (
                  <div className="overflow-hidden rounded-[var(--radius-md)] ring-1 ring-inset ring-[var(--color-border-default)]">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-[var(--color-bg-900)] text-[10px] uppercase tracking-wider text-[var(--color-fg-700)]">
                        <tr>
                          <th className="px-2 py-1 font-medium">Company</th>
                          <th className="px-2 py-1 font-medium">Domain</th>
                          <th className="px-2 py-1 font-medium">Region</th>
                          <th className="px-2 py-1 font-medium">Market</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.rows.slice(0, 5).map((r, i) => (
                          <tr key={i} className="border-t border-[var(--color-border-subtle)]">
                            <td className="px-2 py-1 text-[var(--color-fg-300)]">{r.company_name}</td>
                            <td className="px-2 py-1 font-mono text-[var(--color-fg-500)]">
                              {r.domain ?? "—"}
                            </td>
                            <td className="px-2 py-1 text-[var(--color-fg-500)]">
                              {r.region ?? "—"}
                            </td>
                            <td className="px-2 py-1">
                              <Chip tone="neutral">{r.market}</Chip>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {parsed.rows.length > 5 ? (
                      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-900)] px-2 py-1 text-[10px] italic text-[var(--color-fg-700)]">
                        + {parsed.rows.length - 5} more rows preview hidden
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {result ? (
              <div className="rounded-[var(--radius-md)] bg-[color-mix(in_oklab,var(--color-success-500),transparent_85%)] p-3 ring-1 ring-inset ring-[color-mix(in_oklab,var(--color-success-500),transparent_70%)]">
                <p className="text-xs font-medium text-[var(--color-success-300)]">
                  Upload complete
                </p>
                <p className="mt-1 text-[11px] text-[var(--color-fg-300)]">
                  {result.candidates_new} new prospect{result.candidates_new === 1 ? "" : "s"}{" "}
                  inserted. {result.candidates_duplicate} duplicate
                  {result.candidates_duplicate === 1 ? "" : "s"} skipped (already in /companies).
                </p>
              </div>
            ) : null}
          </div>
        </DrawerBody>

        <DrawerFooter>
          {error ? (
            <p className="mr-auto max-w-sm truncate text-xs text-[var(--color-danger-300)]">{error}</p>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result ? (
            <Button
              type="button"
              variant="primary"
              onClick={handleUpload}
              disabled={uploading || !parsed || parsed.rows.length === 0}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {uploading
                ? "Uploading…"
                : parsed
                  ? `Import ${parsed.rows.length} prospect${parsed.rows.length === 1 ? "" : "s"}`
                  : "Import"}
            </Button>
          ) : null}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
