import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * Supabase client with service-role key.
 * BYPASSES RLS. Use ONLY from trusted server contexts:
 *   - Cron handlers
 *   - Webhook endpoints
 *   - Admin operations behind proper auth
 *
 * NEVER expose this to the browser. NEVER use in Client Components.
 */
export function createServiceRoleClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
