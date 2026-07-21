// Do-not-contact enforcement at SEND time.
//
// `do_not_contact_list` has existed since the initial schema but was only ever
// a data-entry screen — nothing consulted it before sending, so an address on
// the list could still be emailed. It's also the right home for per-ADDRESS
// suppression: prospect-level suppression stops one prospect row, but the same
// person can sit on a duplicate row (same company discovered twice under a
// slightly different name) and get emailed again.
//
// Plain module (NOT "use server") so both server actions and cron routes can
// import it. Accepts any Supabase client (cookie-auth or service-role).

/**
 * Minimal client shape this module needs — works with both the RLS and
 * service-role clients. Deliberately narrow: matching Supabase's fully-typed
 * generic here triggers "type instantiation is excessively deep", and the
 * query builder is a PromiseLike (not a Promise), so it must be typed as such.
 * Call sites cast with `as unknown as DncClient` — an explicit narrowing, not
 * an `any` escape hatch.
 */
export type DncClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        or: (filter: string) => {
          limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
        };
      };
    };
  };
};

/** Minimal insert-capable shape for {@link addEmailToDnc}. */
export type DncInsertClient = {
  from: (table: string) => {
    insert: (payload: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  };
};

export type DncHit = { blocked: true; reason: string } | { blocked: false };

/**
 * True when this address (or its whole domain) is on the do-not-contact list.
 *
 * Fails OPEN on a query error: a transient DB blip must not silently halt all
 * outreach. The cost asymmetry favours it — every send path also re-checks the
 * prospect's own status, and a missed DNC hit is recoverable while a fully
 * stalled queue is not. Errors surface to the caller's logs.
 */
export async function isEmailOnDncList(
  supabase: DncClient,
  tenantId: string,
  email: string | null | undefined,
): Promise<DncHit> {
  if (!email) return { blocked: false };
  const clean = email.trim().toLowerCase();
  const domain = clean.split("@")[1] ?? "";
  if (!clean.includes("@") || !domain) return { blocked: false };

  // Match either the exact address or a blanket domain entry.
  // PostgREST `or` takes a comma-separated filter list.
  const filter = `email.eq.${clean},domain.eq.${domain}`;

  try {
    const { data, error } = await supabase
      .from("do_not_contact_list")
      .select("id, email, domain, entry_type")
      .eq("tenant_id", tenantId)
      .or(filter)
      .limit(1);

    if (error) {
      console.error("[dnc] lookup failed — failing open:", error);
      return { blocked: false };
    }
    const hit = (data ?? [])[0] as
      | { email: string | null; domain: string | null; entry_type: string }
      | undefined;
    if (!hit) return { blocked: false };

    const scope = hit.email ? `address ${hit.email}` : `domain ${hit.domain}`;
    return { blocked: true, reason: `On do-not-contact list (${scope}, ${hit.entry_type})` };
  } catch (err) {
    console.error("[dnc] lookup threw — failing open:", err);
    return { blocked: false };
  }
}

/**
 * Add an address to the do-not-contact list. Used when a bounce proves the
 * mailbox is dead, so a duplicate prospect row can't resurrect it later.
 * Idempotent-ish: a duplicate row is harmless (the check only needs one hit).
 */
export async function addEmailToDnc(
  supabase: DncInsertClient,
  tenantId: string,
  email: string,
  entryType: string,
  notes: string,
): Promise<void> {
  try {
    const { error } = await supabase.from("do_not_contact_list").insert({
      tenant_id: tenantId,
      entry_type: entryType,
      email: email.trim().toLowerCase(),
      notes,
    });
    if (error) console.error("[dnc] insert failed:", error);
  } catch (err) {
    console.error("[dnc] insert threw:", err);
  }
}
