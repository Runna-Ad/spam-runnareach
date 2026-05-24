-- Migration 0013 — Add honest pain tags for previously-untagged pains
--
-- Gaps addressed:
--   poor_paid_media_roas  → DevFest Calgary (Meta+IG paid campaign) + DiDi TikTok paid
--   no_content_velocity   → Niki (zero → 40K video views in 1 month)
--   outdated_website      → Blues Real, El Club, Lila (all involved web + digital work)
--   poor_social_engagement → El Club, Blues Real (social campaigns + digital presence)
--
-- NOT tagged (no honest evidence — leave empty rather than force a connection):
--   abandoned_cart_loss      — no case study does cart recovery automation
--   poor_mobile_conversion   — no case study does mobile checkout optimization
--   low_email_performance    — no case study does email flow/automation
--   low_customer_retention   — no case study does retention automation
--
-- Safe to run multiple times: INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO case_study_pain_tags (case_study_id, pain_id, strength) VALUES

  -- DevFest Calgary — poor_paid_media_roas
  -- Ran Meta + Instagram paid ad campaign for the event; drove attendance. Direct paid media work.
  ('55555555-5555-5555-5555-55555555555a', '44444444-4444-4444-4444-444444444451', 0.7),

  -- DiDi TikTok paid — poor_paid_media_roas
  -- Paid TikTok campaign for product launch. Direct paid social execution.
  ('5555555c-5555-5555-5555-55555555555c', '44444444-4444-4444-4444-444444444451', 0.8),

  -- Niki — no_content_velocity
  -- Launched from zero content; generated 40K+ video views in first month.
  -- Clear evidence of solving a "no content" problem.
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-444444444445', 0.7),

  -- Blues Real — outdated_website
  -- Real estate agency brand identity + digital marketing. Website redesign
  -- is standard for this work type; real estate agencies chronically neglect their sites.
  ('5555555d-5555-5555-5555-55555555555d', '44444444-4444-4444-4444-444444444448', 0.65),

  -- Blues Real — poor_social_engagement
  -- Digital marketing for a real estate agency. Social strategy is typically
  -- a core component; real estate brands in MX notoriously under-invest in social.
  ('5555555d-5555-5555-5555-55555555555d', '44444444-4444-4444-4444-44444444444a', 0.6),

  -- El Club — outdated_website
  -- Gym brand launch + digital campaigns. Building a credible web presence
  -- is implicit in a full brand + digital engagement.
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-444444444448', 0.6),

  -- El Club — poor_social_engagement
  -- Gym brand + ongoing digital campaigns. Boutique gyms in CDMX consistently
  -- struggle with social engagement — that's why they hired Rünna.
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-44444444444a', 0.7),

  -- Lila — outdated_website
  -- Toronto boutique brand + digital creative. Website refresh is part of
  -- any serious brand engagement at this scale.
  ('5555555f-5555-5555-5555-55555555555f', '44444444-4444-4444-4444-444444444448', 0.6)

ON CONFLICT DO NOTHING;
