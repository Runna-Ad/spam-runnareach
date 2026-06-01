"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Bot, Database, Mail, Search, Send, Zap } from "lucide-react";

export interface IntegrationStatus {
  gmailConnected: boolean;
  gmailEmail: string | null;
  anthropicConfigured: boolean;
  braveConfigured: boolean;
  hunterConfigured: boolean;
  anymailConfigured: boolean;
  postmarkConfigured: boolean;
}

interface IntegrationConfig {
  id: string;
  name: string;
  description: string;
  envVar: string;
  icon: React.ReactNode;
  connected: boolean;
  detail?: string | null;
}

interface Props {
  status: IntegrationStatus;
}

export function IntegrationsPage({ status }: Props) {
  const integrations: IntegrationConfig[] = [
    {
      id: "gmail",
      name: "Gmail OAuth",
      description: "Sends outreach emails and reads warmup replies",
      envVar: "Gmail OAuth (configured in /settings/sending)",
      icon: <Mail className="size-5" />,
      connected: status.gmailConnected,
      detail: status.gmailEmail,
    },
    {
      id: "anthropic",
      name: "Anthropic Claude",
      description: "Powers scoring, research, pitch generation and reply classification",
      envVar: "ANTHROPIC_API_KEY",
      icon: <Bot className="size-5" />,
      connected: status.anthropicConfigured,
    },
    {
      id: "brave",
      name: "Brave Search",
      description: "Discovers prospects and researches companies",
      envVar: "BRAVE_SEARCH_API_KEY",
      icon: <Search className="size-5" />,
      connected: status.braveConfigured,
    },
    {
      id: "hunter",
      name: "Hunter.io",
      description: "Finds verified contact emails for high-score prospects (≥70)",
      envVar: "HUNTER_API_KEY",
      icon: <Database className="size-5" />,
      connected: status.hunterConfigured,
    },
    {
      id: "anymail",
      name: "Anymail Finder",
      description: "Finds decision-maker emails for high-score prospects (≥70)",
      envVar: "ANYMAIL_FINDER_API_KEY",
      icon: <Zap className="size-5" />,
      connected: status.anymailConfigured,
    },
    {
      id: "postmark",
      name: "Postmark",
      description: "Transactional emails (invites, notifications)",
      envVar: "POSTMARK_SERVER_TOKEN",
      icon: <Send className="size-5" />,
      connected: status.postmarkConfigured,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-fg-50)]">Integrations</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-500)]">
          External services connected to this workspace. Configure API keys in your Vercel
          environment variables.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {integrations.map((integration) => (
          <Card key={integration.id}>
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-bg-700)] text-[var(--color-fg-300)] ring-1 ring-inset ring-[var(--color-border-default)]">
                  {integration.icon}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-fg-50)]">
                      {integration.name}
                    </span>
                    <Chip tone={integration.connected ? "success" : "danger"}>
                      {integration.connected ? "Connected" : "Not configured"}
                    </Chip>
                  </div>

                  <p className="mt-0.5 text-xs text-[var(--color-fg-500)]">
                    {integration.description}
                  </p>

                  {integration.connected && integration.detail && (
                    <p className="mt-1.5 text-xs font-medium text-[var(--color-fg-300)]">
                      {integration.detail}
                    </p>
                  )}

                  {!integration.connected && (
                    <p className="mt-1.5 text-xs text-[var(--color-fg-600)]">
                      Set{" "}
                      <code className="rounded px-1 py-0.5 bg-[var(--color-bg-700)] font-mono text-[0.7rem] text-[var(--color-fg-400)]">
                        {integration.envVar}
                      </code>{" "}
                      in Vercel environment variables
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
