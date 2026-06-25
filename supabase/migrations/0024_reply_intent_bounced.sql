-- 0024_reply_intent_bounced.sql
-- Add a 'bounced' value to the reply_intent enum. A bounce / non-delivery report
-- (MAILER-DAEMON, "Undeliverable", "Delivery Status Notification (Failure)") means
-- the address is dead — it must be suppressed, NOT snoozed like an out-of-office.
-- The classifier now detects these and the inbox suggests "Suppress (undeliverable)".

alter type reply_intent add value if not exists 'bounced';
