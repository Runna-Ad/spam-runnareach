"use client";

import { Building2, Plus } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import type { NotableClient } from "@/lib/notable-clients/queries";
import { cn } from "@/lib/utils";
import { NotableClientEditDrawer } from "./notable-client-edit-drawer";

const MARKET_FLAG: Record<string, string> = {
  CA: "🇨🇦",
  MX: "🇲🇽",
  US: "🇺🇸",
  LATAM: "🌎",
};

interface Props {
  clients: NotableClient[];
}

export function NotableClientsGrid({ clients }: Props) {
  const [editing, setEditing] = React.useState<NotableClient | null>(null);
  const [creating, setCreating] = React.useState(false);

  return (
    <>
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-fg-500)]">
          {clients.length} client{clients.length === 1 ? "" : "s"} ·{" "}
          <span className="text-[var(--color-fg-700)]">
            Used in Tier 2 (industry match) and Tier 3 (name-drop) pitch hooks.
          </span>
        </p>
        <Button
          type="button"
          size="sm"
          variant="primary"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add client
        </Button>
      </div>

      {/* Grid */}
      {clients.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-subtle)] py-16">
          <Building2 className="h-8 w-8 text-[var(--color-fg-700)]" aria-hidden />
          <p className="text-sm text-[var(--color-fg-500)]">No notable clients yet.</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setCreating(true)}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add your first client
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clients.map((client) => (
            <NotableClientCard
              key={client.id}
              client={client}
              onEdit={() => setEditing(client)}
            />
          ))}
        </div>
      )}

      {/* Edit drawer */}
      <NotableClientEditDrawer
        client={editing}
        open={!!editing}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
      />

      {/* Create drawer */}
      <NotableClientEditDrawer
        client={null}
        open={creating}
        onOpenChange={setCreating}
      />
    </>
  );
}

function NotableClientCard({
  client,
  onEdit,
}: {
  client: NotableClient;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="group w-full text-left"
    >
      <Card
        className={cn(
          "transition-[box-shadow]",
          "group-hover:ring-[var(--color-accent-300)]",
          !client.is_active && "opacity-50",
        )}
      >
        <CardContent className="flex flex-col gap-3 p-4">
          {/* Header row */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-[var(--color-fg-50)]">
                  {client.name}
                </span>
                {!client.is_active && (
                  <Chip tone="neutral" className="shrink-0 text-[10px]">
                    inactive
                  </Chip>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-0.5">
                {client.markets.map((m) => (
                  <span key={m} className="text-sm" aria-label={m}>
                    {MARKET_FLAG[m] ?? m}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Relationship + result */}
          {client.relationship_description ? (
            <p className="text-xs text-[var(--color-fg-300)]">
              {client.relationship_description}
            </p>
          ) : null}
          {client.key_result ? (
            <p className="text-xs font-medium text-[var(--color-accent-300)]">
              {client.key_result}
            </p>
          ) : null}

          {/* Industry tags */}
          {client.industry_tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {client.industry_tags.slice(0, 5).map((tag) => (
                <Chip key={tag} tone="neutral" className="text-[10px]">
                  {tag}
                </Chip>
              ))}
              {client.industry_tags.length > 5 ? (
                <Chip tone="neutral" className="text-[10px]">
                  +{client.industry_tags.length - 5}
                </Chip>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </button>
  );
}
