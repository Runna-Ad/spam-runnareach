import { ProfileForm } from "@/components/settings/profile-form";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SettingsProfilePage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: profileRow } = await supabase
    .from("users")
    .select("timezone")
    .eq("id", user.id)
    .single<{ timezone: string }>();

  return (
    <ProfileForm
      user={{
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        tenantDisplayName: user.tenantDisplayName,
        timezone: profileRow?.timezone ?? "America/Edmonton",
      }}
    />
  );
}
