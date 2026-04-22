import { ScrollText, Target, Users2, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardHome() {
  const user = await requireUser();
  const supabase = await createClient();

  // Parallel fetch of Phase 0 seed counts. RLS ensures we only see our tenant's rows.
  const [caseStudies, services, icps, teamUsers] = await Promise.all([
    supabase.from("case_studies").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("services").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("icps").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("users").select("id", { count: "exact", head: true }),
  ]);

  const stats = [
    {
      label: "Case studies",
      value: caseStudies.count ?? 0,
      icon: ScrollText,
      route: "/case-studies",
    },
    { label: "Services", value: services.count ?? 0, icon: Wrench, route: "/settings" },
    { label: "Active ICPs", value: icps.count ?? 0, icon: Target, route: "/icp" },
    { label: "Team", value: teamUsers.count ?? 0, icon: Users2, route: "/settings/users" },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Greeting */}
      <div>
        <p className="font-mono text-xs tracking-wider text-[var(--color-fg-500)]">
          TODAY · {new Date().toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" })}
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-[var(--color-fg-50)]">
          {greeting()}, {user.fullName?.split(" ")[0] ?? "there"}.
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          {user.tenantDisplayName} · Phase 0 foundation is live.
        </p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-bg-700)] text-[var(--color-fg-300)]">
                  <Icon className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <div className="font-mono text-2xl font-semibold tracking-tight text-[var(--color-fg-50)]">
                    {s.value}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-500)]">
                    {s.label}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Today queue placeholder */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Today</CardTitle>
          <Chip tone="accent">Phase 0</Chip>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            <ActionRow
              status="pending"
              title="Finish warming setup"
              meta="tasks/warming-setup-guide.md"
              detail="Buy runna.agency + runnareach.com. Start 2-week warming clock."
            />
            <ActionRow
              status="pending"
              title="Invite Runna CA teammates"
              meta="/settings/users"
              detail="Admin can invite once auth is live. You're here."
            />
            <ActionRow
              status="pending"
              title="Curate 10 seeded case studies"
              meta="/case-studies"
              detail="Review hero metrics + pain taxonomy tags before Phase 3."
            />
            <ActionRow
              status="blocked"
              title="Connect Anthropic API key"
              meta=".env.local → ANTHROPIC_API_KEY"
              detail="Blocks Phase 2 research + scoring + pitch generation."
            />
            <ActionRow
              status="blocked"
              title="Connect Google Cloud (Places + Gmail OAuth)"
              meta=".env.local → GOOGLE_*"
              detail="Blocks Phase 1 discovery + Phase 4 sending."
            />
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

interface ActionRowProps {
  status: "pending" | "blocked" | "done";
  title: string;
  meta: string;
  detail: string;
}

function ActionRow({ status, title, meta, detail }: ActionRowProps) {
  const tone = status === "blocked" ? "danger" : status === "done" ? "success" : "warning";
  const label = status === "blocked" ? "Blocked" : status === "done" ? "Done" : "Pending";
  return (
    <li className="flex items-start gap-3 py-3">
      <Chip tone={tone} className="mt-0.5 shrink-0">
        {label}
      </Chip>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-[var(--color-fg-50)]">{title}</span>
          <span className="font-mono text-[10px] text-[var(--color-fg-500)]">{meta}</span>
        </div>
        <p className="mt-0.5 text-xs text-[var(--color-fg-500)]">{detail}</p>
      </div>
    </li>
  );
}
