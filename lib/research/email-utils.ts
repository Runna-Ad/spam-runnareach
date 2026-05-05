export function isRoleBasedEmail(email: string): boolean {
  const local = email.split("@")[0];
  if (!local) return true;
  const lower = local.toLowerCase();
  return [
    "info",
    "hello",
    "contact",
    "sales",
    "support",
    "admin",
    "team",
    "office",
    "hi",
    "hey",
    "marketing",
    "press",
    "media",
    "billing",
  ].includes(lower);
}
