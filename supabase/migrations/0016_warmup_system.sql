-- ─────────────────────────────────────────────────────────────────────────────
-- 0016_warmup_system.sql
-- Self-hosted email warmup engine tables.
--
-- Tables
--   warmup_config     – one row per sending identity, tracks ramp progress
--   warmup_buddies    – IMAP-accessible reply accounts (app password auth)
--   warmup_log        – immutable record of every warmup email pair
--   warmup_templates  – subject/body library for natural-looking exchanges
--   domain_health     – daily Postmaster Tools snapshot
-- ─────────────────────────────────────────────────────────────────────────────

-- ── warmup_config ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warmup_config (
  id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sending_email      TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'maintenance', 'completed')),
  start_date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_day        INTEGER     NOT NULL DEFAULT 1,
  daily_target       INTEGER     NOT NULL DEFAULT 5,
  emails_sent_today  INTEGER     NOT NULL DEFAULT 0,
  last_reset_date    DATE        NOT NULL DEFAULT CURRENT_DATE,
  last_buddy_index   INTEGER     NOT NULL DEFAULT 0,
  pause_reason       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sending_email)
);

ALTER TABLE warmup_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_warmup_config" ON warmup_config
  USING (tenant_id = auth.uid());

-- ── warmup_buddies ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warmup_buddies (
  id                     UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  email                  TEXT    NOT NULL UNIQUE,
  display_name           TEXT    NOT NULL DEFAULT '',
  -- The VALUE stored here is the Vercel env var NAME, e.g. "WARMUP_BUDDY_1_APP_PASSWORD"
  -- The actual app password lives in Vercel env vars, never in the DB.
  app_password_secret    TEXT    NOT NULL,
  email_env_var          TEXT    NOT NULL,  -- e.g. "WARMUP_BUDDY_1_EMAIL"
  imap_host              TEXT    NOT NULL DEFAULT 'imap.gmail.com',
  imap_port              INTEGER NOT NULL DEFAULT 993,
  smtp_host              TEXT    NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port              INTEGER NOT NULL DEFAULT 465,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  last_used_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Buddies are global (no tenant_id) — shared infrastructure, not per-user data.
-- No RLS needed; accessed only from server-side API routes.

-- ── warmup_log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warmup_log (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID        NOT NULL,
  config_id       UUID        NOT NULL REFERENCES warmup_config(id) ON DELETE CASCADE,
  buddy_id        UUID        REFERENCES warmup_buddies(id) ON DELETE SET NULL,
  direction       TEXT        NOT NULL CHECK (direction IN ('sent', 'received')),
  subject         TEXT        NOT NULL,
  message_id      TEXT,           -- Gmail message-id header
  thread_id       TEXT,           -- Gmail thread id (pairs sent ↔ reply)
  landed_in_inbox BOOLEAN,        -- null until IMAP check runs
  reply_sent      BOOLEAN         NOT NULL DEFAULT false,
  day_number      INTEGER         NOT NULL,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

ALTER TABLE warmup_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_warmup_log" ON warmup_log
  USING (tenant_id = auth.uid());

CREATE INDEX idx_warmup_log_config ON warmup_log(config_id, created_at DESC);
CREATE INDEX idx_warmup_log_thread ON warmup_log(thread_id) WHERE thread_id IS NOT NULL;

-- ── warmup_templates ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warmup_templates (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  category    TEXT    NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'b2b', 'question', 'update', 'casual', 'followup')),
  subject     TEXT    NOT NULL,
  body_text   TEXT    NOT NULL,
  reply_text  TEXT    NOT NULL,  -- buddy's reply body
  language    TEXT    NOT NULL DEFAULT 'en',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── domain_health ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_health (
  id                        UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id                 UUID        NOT NULL,
  domain                    TEXT        NOT NULL,
  recorded_date             DATE        NOT NULL DEFAULT CURRENT_DATE,
  domain_reputation         TEXT        CHECK (domain_reputation IN ('HIGH','MEDIUM','LOW','BAD','REPUTATION_CATEGORY_UNSPECIFIED')),
  ip_reputation             TEXT        CHECK (ip_reputation IN ('HIGH','MEDIUM','LOW','BAD','REPUTATION_CATEGORY_UNSPECIFIED')),
  spam_rate                 NUMERIC(6,4),   -- 0.0000 to 1.0000
  spf_success_ratio         NUMERIC(6,4),
  dkim_success_ratio        NUMERIC(6,4),
  dmarc_success_ratio       NUMERIC(6,4),
  inbound_encryption_ratio  NUMERIC(6,4),
  raw_response              JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, domain, recorded_date)
);

ALTER TABLE domain_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_domain_health" ON domain_health
  USING (tenant_id = auth.uid());

CREATE INDEX idx_domain_health_tenant_domain ON domain_health(tenant_id, domain, recorded_date DESC);

-- ── Seed: warmup_buddies ──────────────────────────────────────────────────────
INSERT INTO warmup_buddies (email, display_name, app_password_secret, email_env_var)
VALUES
  ('randompete31@gmail.com',  'Pete R',  'WARMUP_BUDDY_1_APP_PASSWORD', 'WARMUP_BUDDY_1_EMAIL'),
  ('lepetedv@gmail.com',      'Pete D',  'WARMUP_BUDDY_2_APP_PASSWORD', 'WARMUP_BUDDY_2_EMAIL'),
  ('proacademyhq@gmail.com',  'Pro HQ',  'WARMUP_BUDDY_3_APP_PASSWORD', 'WARMUP_BUDDY_3_EMAIL')
ON CONFLICT (email) DO UPDATE SET
  display_name         = EXCLUDED.display_name,
  app_password_secret  = EXCLUDED.app_password_secret,
  email_env_var        = EXCLUDED.email_env_var;

-- ── Seed: warmup_templates (50+ varied, natural-sounding exchanges) ───────────
INSERT INTO warmup_templates (category, subject, body_text, reply_text, language) VALUES

-- general (10)
('general', 'Quick check-in', 'Hey, just checking in. Hope you''re having a good week! Anything exciting going on your end?', 'Ha, nothing too exciting here — just keeping busy. Hope your week''s going well too!', 'en'),
('general', 'Re: Monday', 'Hope you had a good weekend. I''ve been meaning to reach out — let me know if you''re free for a quick call sometime this week.', 'Sounds good! Let me know what time works for you and I''ll make it happen.', 'en'),
('general', 'Following up', 'Hey, wanted to follow up on our last conversation. Did you get a chance to look into that?', 'Yes! Sorry for the delay — I''ll get back to you with more details by end of week.', 'en'),
('general', 'Checking availability', 'Hi, are you available Thursday afternoon? Would love to reconnect briefly.', 'Thursday works! Let''s say 3pm your time — does that work?', 'en'),
('general', 'Quick note', 'Just wanted to send a quick note — saw something that reminded me of our last chat. Hope all is well!', 'That''s kind of you! Things are going well on my end. Let''s catch up soon.', 'en'),
('general', 'Hi from the other side', 'Hope this finds you well. Wanted to touch base and see how things are going since we last spoke.', 'All good here! Thanks for reaching out. Looking forward to hearing what you''ve been up to.', 'en'),
('general', 'Long time', 'It''s been a while! Hope everything is going smoothly. Would love to catch up when you have a moment.', 'Yes, it has! Let''s definitely reconnect. What does your schedule look like next week?', 'en'),
('general', 'Thinking of you', 'Saw something interesting today that made me think of your work. Hope things are going well!', 'That''s so thoughtful! I''d love to hear more. Let''s find time to chat.', 'en'),
('general', 'Any updates?', 'Hey, just wanted to check in — any updates on your end? Been a while since we last connected.', 'Things have been moving fast! I''ll share more details soon. Good to hear from you.', 'en'),
('general', 'Wednesday check-in', 'Hope your week is off to a great start. Just checking in — anything I can help with?', 'Week''s going well, thanks for asking! I''ll keep you posted if anything comes up.', 'en'),

-- b2b (10)
('b2b', 'Partnership opportunity', 'Hi, I came across your company and thought there might be some synergies worth exploring. Would you be open to a brief conversation?', 'Thanks for reaching out! Happy to explore that. What did you have in mind?', 'en'),
('b2b', 'Collaboration idea', 'I''ve been following your work and had an idea for a potential collaboration. Do you have 15 minutes this week?', 'Interesting! I''d be open to hearing more. What''s the general direction you''re thinking?', 'en'),
('b2b', 'Re: our call last week', 'Great speaking with you last week. I wanted to follow up with some of the points we discussed. Let me know if you''d like to continue the conversation.', 'Yes, really enjoyed the call! I''ve been thinking about it since. Let''s keep the momentum going.', 'en'),
('b2b', 'Intro + quick question', 'Hi, a mutual contact suggested I reach out. I have a quick question about your process — would you be open to a brief exchange?', 'Of course! Feel free to ask — happy to help if I can.', 'en'),
('b2b', 'Following up on proposal', 'Wanted to follow up on the proposal I sent over. Have you had a chance to review it? Happy to answer any questions.', 'Yes, I''ve had a look! I have a few follow-up questions. Can we schedule time this week?', 'en'),
('b2b', 'Market update', 'I''ve been doing some research in our space and came across some interesting findings. Happy to share if useful for your planning.', 'That would be very helpful! Please do share — always looking for good market intel.', 'en'),
('b2b', 'Q3 check-in', 'Can you believe Q3 is almost over? Wanted to reach out and see how things are tracking for you before the end of quarter.', 'Time flies! Q3 has been intense but productive. Would love to debrief — let''s connect.', 'en'),
('b2b', 'Referral from the team', 'A colleague of mine mentioned your name and suggested I reach out. Looking forward to connecting.', 'Great to hear from you! Always good to expand the network. What can I help you with?', 'en'),
('b2b', 'Quick resource share', 'I thought you might find this useful given what you''re working on. Let me know if you want to discuss further.', 'Thanks for sharing! I''ll take a look and follow up with any thoughts. Appreciate it.', 'en'),
('b2b', 'Checking in post-event', 'Great seeing you at the event last week. Wanted to follow up and continue the conversation we started.', 'Yes! Really enjoyed chatting. Let''s find time to dive deeper — lots of overlap in what we''re working on.', 'en'),

-- question (10)
('question', 'Quick question for you', 'Hope you''re doing well. I have a quick question about your experience with [topic] — would love your perspective.', 'Of course! I''m happy to share my thoughts. What would you like to know?', 'en'),
('question', 'Your take on this?', 'I''ve been thinking about this problem and wanted a second opinion. How would you approach it?', 'Great question — I''ve actually dealt with something similar. Here''s what worked for me...', 'en'),
('question', 'Have you tried X?', 'Curious if you''ve had a chance to try out [tool/approach]. We''ve been experimenting with it and wanted your thoughts.', 'I have actually! Interesting results — happy to compare notes.', 'en'),
('question', 'Best way to handle this?', 'Running into a small challenge and thought you might have dealt with something similar. What''s your go-to approach?', 'I''ve definitely been there! Here''s what I''d suggest based on what worked for us...', 'en'),
('question', 'Advice on vendors', 'We''re evaluating a few vendors for a project and I know you''ve been in this space longer. Any strong recommendations or things to avoid?', 'Happy to help! There are a few I''d steer clear of — let me know more about your use case.', 'en'),
('question', 'How do you measure success?', 'Curious how your team measures success for this type of initiative. We''re building our own framework and looking for benchmarks.', 'Good question! We''ve iterated a lot on this. Happy to walk you through our current framework.', 'en'),
('question', 'Which would you choose?', 'Torn between two approaches here. If you had to choose, which direction would you go and why?', 'Based on what you''ve described, I''d lean toward the second option — here''s my reasoning...', 'en'),
('question', 'Your experience with outbound?', 'We''re revamping our outbound strategy. Would love to hear what''s been working for you lately.', 'Outbound has been interesting lately — a lot has changed. Let''s set up a call and I''ll share what we''re seeing.', 'en'),
('question', 'Thoughts on the new approach?', 'Wanted to get your take before we finalize this. Quick 5-minute read — does this make sense?', 'I read through it — makes sense overall! I have one suggestion that might strengthen section 2.', 'en'),
('question', 'Any experience with this?', 'First time tackling this type of project. Have you done something similar? Would appreciate any lessons learned.', 'Yes, I went through this about 18 months ago. There are definitely some pitfalls to avoid — happy to share!', 'en'),

-- update (8)
('update', 'Quick update', 'Just wanted to send a quick update on how things are progressing. Looking good so far!', 'Great to hear! Thanks for keeping me in the loop. Let me know if you need anything.', 'en'),
('update', 'Progress report', 'We''ve hit a few key milestones this week. Wanted to keep you updated and flag one item for your attention.', 'Thanks for the update! The milestones look great. What item needs my attention?', 'en'),
('update', 'Project status', 'Things are moving along well on our end. I''ll have more concrete numbers by end of week.', 'Sounds like good progress! Looking forward to the numbers. Let me know if there''s anything blocking you.', 'en'),
('update', 'New development', 'Something interesting came up that might affect our plans. Wanted to flag it early and get your thoughts.', 'Good to know early! Let''s discuss — what''s the best way to handle it?', 'en'),
('update', 'This week''s highlights', 'A lot happened this week! Wanted to share the top three things before the weekend.', 'Love the recap! The third item especially stands out — let''s talk more about that.', 'en'),
('update', 'Heads up on timing', 'Just a heads up that the timeline has shifted slightly. Nothing major, but wanted you to know ASAP.', 'Thanks for the early notice — much appreciated. How does this affect the next phase?', 'en'),
('update', 'All on track', 'Just confirming everything is on track from our end. No blockers at the moment.', 'Great to hear! Keep me posted if anything changes. Talk soon.', 'en'),
('update', 'Key decision made', 'We finally landed on a direction after a lot of back-and-forth. Happy to share the reasoning.', 'Looking forward to hearing it! I know that decision wasn''t easy. Good to have clarity.', 'en'),

-- casual (7)
('casual', 'Hope you''re well', 'Hey! Just dropping in to say hi and hope everything is going well on your end.', 'All good here! Hope the same for you. Let''s catch up soon.', 'en'),
('casual', 'Quick hello', 'Hi! Just thought I''d reach out. No agenda, just saying hello :)', 'Ha, always nice to get a non-agenda email! Hope things are great your end.', 'en'),
('casual', 'How''s everything?', 'Hey, how''s everything going? Haven''t heard from you in a bit.', 'Good! Busy but good. How about you? What have you been up to?', 'en'),
('casual', 'Weekend plans?', 'Any good plans for the weekend? I''m looking for new ideas!', 'Nothing too crazy planned — mostly recharging. Let me know if you find any good spots!', 'en'),
('casual', 'Saw this and thought of you', 'Just sent you something that I thought was right up your alley. Let me know what you think!', 'Ha, you know me well! That''s great — I''ll check it out and let you know my take.', 'en'),
('casual', 'Random thought', 'Had a random thought today that I figured I''d share with you. Probably nothing but might spark something.', 'Love random thoughts! What''s on your mind?', 'en'),
('casual', 'Still alive :)', 'I know, I know — it''s been way too long. Just wanted to make sure you know I haven''t fallen off the face of the earth!', 'Ha! Good to know. It really has been too long. Let''s actually make plans this time.', 'en'),

-- followup (7)
('followup', 'Following up', 'Hi, just following up on my previous email. Let me know when you get a chance to review.', 'Sorry for the delay! I''ll get back to you by end of day tomorrow.', 'en'),
('followup', 'Any news?', 'Wanted to check in — any updates since we last spoke? Still interested in moving forward.', 'Yes, good timing! I was just about to reach out. Let''s connect this week.', 'en'),
('followup', 'Re: last week''s email', 'Just bumping this up in case it got buried. Let me know if you have any questions.', 'Appreciate the bump! I did see it — just needed a moment to think it through. Let''s talk.', 'en'),
('followup', 'Still on your radar?', 'Wanted to check if this is still something you''re interested in or if priorities have shifted.', 'Still on my radar! Just been busy. Can we find time next week?', 'en'),
('followup', 'Keeping the thread alive', 'Hey, just keeping the thread alive. Happy to adjust the proposal if anything has changed on your end.', 'Appreciate the patience! Let me loop in one more person before we move forward.', 'en'),
('followup', 'Any blockers?', 'Just wanted to check — are there any blockers I can help remove? Happy to jump on a call.', 'No major blockers — just working through the internal process. Should have an answer this week.', 'en'),
('followup', 'One last follow-up', 'This will be my last follow-up — totally understand if this isn''t the right time. Just let me know!', 'No, please — I''m glad you followed up. The timing is actually better now. Let''s reconnect.', 'en')

ON CONFLICT DO NOTHING;

-- ── Seed: warmup_config ───────────────────────────────────────────────────────
-- After running this migration, insert one config row for your sending identity.
-- Replace <YOUR_TENANT_UUID> with your actual auth.users.id from the Supabase
-- dashboard (Authentication → Users).
--
-- INSERT INTO warmup_config (tenant_id, sending_email, status, daily_target)
-- VALUES ('<YOUR_TENANT_UUID>', 'pedro@runna.io', 'active', 5)
-- ON CONFLICT (tenant_id, sending_email) DO NOTHING;
