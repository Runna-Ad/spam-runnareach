[2026-10-26] A recurring notice must remember what it already said, keyed on the thing that can change
WHAT HAPPENED: The veto digest (lib/autopilot/tick.ts sendVetoDigest) listed every approved AUTO email within 24h at each slot, so an email waiting out a weekend for sending hours appeared in up to 6-8 digests. The fix records the listed (pitch_id, scheduled_send_at) pairs in the digest's own audit_log metadata and lists only pairs no earlier digest listed (lib/autopilot/hold.ts planVetoDigest). Keying on the pair, not the pitch, keeps "held then re-approved" announced again.
RULE: A periodic notification that lists a backlog stores what it listed in the same record it already writes after delivery, and the next run lists only the difference plus one count line for the rest. Key the "already announced" set on the fields whose change makes the item news again (here the scheduled time), and compare timestamps as instants (Date.parse), never as strings: Postgres returns "+00:00" where JS writes "Z".
TAGS: autopilot, notifications, digest

## Out of scope, noticed
- none
