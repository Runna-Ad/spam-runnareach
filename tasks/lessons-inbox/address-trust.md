[2026-10-19] "Trusted source" and "verdict send" were two different questions that looked like one
WHAT HAPPENED: The governor's TRUSTED_SOURCES and the gate's VERIFIED_PROVENANCE both listed "anymail" and "hunter" as trusted, while verify-recipient.ts held those same sources for a person (FINDER_SOURCES). The finder hold only worked because laneFor also requires verify === "send". address-trust merged the two copied lists into isTrustedForAutoSend (lib/research/verify-recipient.ts) and kept "anymail"/"hunter" in it so no existing value changed behaviour; a table test (tests/address-trust.test.ts) pins every selected_by value across provenance, finder flag, lane trust, gate trust and end-to-end lane.
RULE: When a source's trust is decided in more than one place, a table test over every known value, asserting each layer AND the end-to-end result, is what makes "one predicate" stick. A value that one layer trusts and another holds is a smell: name which layer is authoritative in the comment on both.
TAGS: research, autopilot, send-gate, provenance

[2026-10-19] A vendor's best-guess field must never be the fallback for its verified field
WHAT HAPPENED: lib/research/anymail-finder.ts took `valid_email ?? email` and only rejected not_found/blacklisted, so Anymail's unverified guess (status risky, valid_email null) was stored like a verified address. Now verifiedEmailOf() requires email_status "valid" AND valid_email; the result is stored as selected_by "anymail_verified". Anymail's docs were unreachable from the sandbox (egress proxy refused anymailfinder.com), so the shape is coded from the existing client's field names, not re-checked against v5.1 docs.
RULE: For any third-party lookup, keep only the field the vendor marks as verified, test the "guess present, verified null" fixture, and store the verification status (as a source value or column) so a later bounce can be traced to it.
TAGS: research, anymail, enrichment

## Out of scope, noticed
- lib/research/verify-recipient.ts provenanceOf lists "snapverify" (no row uses it; enrich-contacts writes "snapverify_smtp", which falls to the default "medium"). Harmless, but the case label is dead.
- lib/pitches/contacts.ts:17 comment lists 'anymail' among example sources; not updated (read-only for this brief).
