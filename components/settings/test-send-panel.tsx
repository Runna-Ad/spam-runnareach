"use client";

import { Send } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { SenderInbox } from "@/lib/settings/sending-queries";
import { sendTestEmail } from "@/lib/settings/test-send-action";

/**
 * Send one sample pitch through the real send pipeline to an address you pick —
 * the way to check accents, the CTA button, the footer and the unsubscribe
 * links in a real inbox without creating a prospect or a follow-up sequence.
 */
export function TestSendPanel({ inboxes }: { inboxes: SenderInbox[] }) {
  const connected = inboxes.filter((i) => i.gmail_connected);
  const [inboxId, setInboxId] = React.useState(connected[0]?.id ?? "");
  const [to, setTo] = React.useState("");
  const [lang, setLang] = React.useState<"en" | "es">("es");
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null);

  if (connected.length === 0) return null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      const r = await sendTestEmail({ inbox_id: inboxId, to, lang });
      setResult(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error });
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-[var(--color-fg-50)]">Send a test email</h3>
          <p className="text-xs text-[var(--color-fg-500)]">
            A sample pitch through the real pipeline: accents, button, footer, unsubscribe. No prospect, no
            follow-ups. Use a +tag address (you+test1@gmail.com): clicking its unsubscribe link blocks that address
            for good.
          </p>
        </div>
        <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <div className="flex flex-col gap-1">
            <Label htmlFor="test-to">Send to</Label>
            <Input
              id="test-to"
              type="email"
              required
              placeholder="you+test1@gmail.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="test-from">From</Label>
            <Select id="test-from" value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
              {connected.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.email}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="test-lang">Language</Label>
            <Select id="test-lang" value={lang} onChange={(e) => setLang(e.target.value === "en" ? "en" : "es")}>
              <option value="es">Español</option>
              <option value="en">English</option>
            </Select>
          </div>
          <Button type="submit" variant="primary" disabled={pending || !to}>
            <Send className="h-3.5 w-3.5" aria-hidden /> {pending ? "Sending…" : "Send test"}
          </Button>
        </form>
        {result && (
          <p
            role="status"
            className={result.ok ? "text-xs text-[var(--color-success-300)]" : "text-xs text-red-300"}
          >
            {result.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
