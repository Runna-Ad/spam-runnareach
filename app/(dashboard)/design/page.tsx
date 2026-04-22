import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Kbd } from "@/components/ui/kbd";

const COLOR_TOKENS = [
  { label: "bg-900 · navy deep", token: "--color-bg-900" },
  { label: "bg-800 · navy", token: "--color-bg-800" },
  { label: "bg-700 · hover", token: "--color-bg-700" },
  { label: "bg-600 · raised", token: "--color-bg-600" },
  { label: "fg-50 · runna white", token: "--color-fg-50" },
  { label: "fg-300 · runna light", token: "--color-fg-300" },
  { label: "fg-500 · muted", token: "--color-fg-500" },
  { label: "accent-300 · runna purple", token: "--color-accent-300" },
  { label: "accent-400 · purple dark", token: "--color-accent-400" },
  { label: "brand-pink", token: "--color-brand-pink" },
  { label: "brand-gold", token: "--color-brand-gold" },
  { label: "success-500", token: "--color-success-500" },
  { label: "warning-500", token: "--color-warning-500" },
  { label: "danger-500 · pink", token: "--color-danger-500" },
  { label: "info-500", token: "--color-info-500" },
];

export default function DesignShowcase() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="font-mono text-xs tracking-wider text-[var(--color-fg-500)]">
          /design
        </h1>
        <p className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-gradient-runna">
          Runna design system
        </p>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          Tokens + components aligned to the Rünna 2026 brand manual. Poppins for display, Inter for UI, purple hero, pink + gold accents.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Brand gradients</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div
              className="flex h-16 items-end justify-start rounded-[var(--radius-md)] p-2 text-[11px] text-white/90"
              style={{ background: "var(--gradient-runna-main)" }}
            >
              --gradient-runna-main
            </div>
            <div
              className="flex h-16 items-end justify-start rounded-[var(--radius-md)] p-2 text-[11px] text-white/90"
              style={{ background: "var(--gradient-runna-purple-pink)" }}
            >
              --gradient-runna-purple-pink
            </div>
            <div
              className="flex h-16 items-end justify-start rounded-[var(--radius-md)] p-2 text-[11px] text-[var(--color-fg-300)] ring-1 ring-inset ring-[var(--color-border-default)]"
              style={{ background: "var(--gradient-runna-subtle)" }}
            >
              --gradient-runna-subtle
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Color tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {COLOR_TOKENS.map(({ label, token }) => (
              <div
                key={token}
                className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg-900)] p-2 ring-1 ring-inset ring-[var(--color-border-subtle)]"
              >
                <div
                  className="h-6 w-6 rounded-[var(--radius-sm)] ring-1 ring-inset ring-[var(--color-border-default)]"
                  style={{ background: `var(${token})` }}
                  aria-hidden
                />
                <div className="min-w-0">
                  <div className="truncate text-xs text-[var(--color-fg-50)]">{label}</div>
                  <div className="truncate font-mono text-[10px] text-[var(--color-fg-500)]">
                    {token}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Buttons</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Approve pitch</Button>
            <Button variant="secondary">Edit</Button>
            <Button variant="ghost">Skip</Button>
            <Button variant="danger">Reject</Button>
            <Button variant="link">View case study</Button>
            <Button variant="primary" size="sm">Send</Button>
            <Button variant="primary" size="lg">Ship it</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chips</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip>Neutral</Chip>
            <Chip tone="accent">Match 94</Chip>
            <Chip tone="success">Won</Chip>
            <Chip tone="warning">Review</Chip>
            <Chip tone="danger">Hot lead</Chip>
            <Chip tone="info">Phase 3</Chip>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keyboard</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-fg-300)]">
            <span>
              Palette <Kbd>⌘</Kbd> <Kbd>K</Kbd>
            </span>
            <span>
              Sidebar <Kbd>⌘</Kbd> <Kbd>\</Kbd>
            </span>
            <span>
              Approve <Kbd>A</Kbd>
            </span>
            <span>
              Edit <Kbd>E</Kbd>
            </span>
            <span>
              Reject <Kbd>R</Kbd>
            </span>
            <span>
              Skip <Kbd>S</Kbd>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Typography</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <p className="font-[family-name:var(--font-display)] text-4xl font-bold tracking-tight text-gradient-runna">
              Grounded pitches. Real replies.
            </p>
            <p className="font-[family-name:var(--font-display)] text-2xl font-light tracking-tight text-[var(--color-fg-50)]">
              Poppins · display · 24 / 36 / 48
            </p>
            <p className="text-base text-[var(--color-fg-300)]">
              Inter · body · 16 · 12 years of Rünna receipts, one browser tab.
            </p>
            <p className="font-mono text-xs tracking-tight text-[var(--color-fg-500)]">
              MONO · MATCH_94 · UNLIMITED_DESIGN · SHOPIFY_CANDLE_CO
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
