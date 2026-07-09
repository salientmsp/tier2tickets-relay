/** Small string normalizers shared by the Halo mock and the Gorelo sync. */

/** Short-lowercase a hostname: strip domain, lowercase, trim. e.g. "PC-01.corp.local" -> "pc-01". */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return "";
  return host.trim().toLowerCase().split(".")[0] ?? "";
}

/** Lowercase/trim an email. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}
