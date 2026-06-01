// Sentry server-side configuration (Node.js runtime — server actions, API routes).
// Captures pipeline errors, Claude API failures, server action crashes, and AI call traces.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // 100% in dev, 5% in production — pipeline is high-volume, stay well under free tier
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.05,

  // Required for AI monitoring — streams GenAI spans so token counts appear in traces
  streamGenAiSpans: true,

  // Attach local variable values to stack frames — makes debugging pipeline failures much easier
  includeLocalVariables: true,

  // Enable Sentry Logs product (structured log capture)
  enableLogs: true,

  maxBreadcrumbs: 30,

  // NOTE: sendDefaultPii intentionally false — prompts contain prospect research data.
  // Token counts, model names, and latency ARE tracked; prompt/completion content is NOT.
  sendDefaultPii: false,

  integrations: [
    // Auto-instruments every @anthropic-ai/sdk call — tracks model, token usage, latency, errors.
    // Visible in Sentry → AI → Agents dashboard.
    Sentry.anthropicAIIntegration(),
  ],
});
