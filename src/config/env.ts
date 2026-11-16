export type Env = {
  AUTH_ISSUER: string;
  AUTH_JWKS_URL: string;
  AUTH_INTERNAL_URL: string;
  AUTH_CLIENT_ID: string;
  AUTH_CLIENT_PRIVATE_KEY: string;
  WEB_APP_URL: string;
  API_PUBLIC_URL: string;
  PORTAL_URL: string;
  AUTH_PUBLIC_URL: string;
  SESSION_COOKIE_SECURE: boolean;
  TRUST_PROXY_HOPS: number;
};
export function validateEnv(
  raw: Record<string, unknown>,
): Env & Record<string, unknown> {
  const result = { ...raw } as Env & Record<string, unknown>;
  const required = [
    "AUTH_ISSUER",
    "AUTH_JWKS_URL",
    "AUTH_INTERNAL_URL",
    "AUTH_CLIENT_ID",
    "AUTH_CLIENT_PRIVATE_KEY",
  ];
  if (raw.BMS_SESSION_HOST === "true")
    required.push(
      "WEB_APP_URL",
      "API_PUBLIC_URL",
      "PORTAL_URL",
      "AUTH_PUBLIC_URL",
    );
  const invalid: string[] = [];
  for (const key of required)
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim())
      invalid.push(key);
  for (const key of [
    "AUTH_JWKS_URL",
    "AUTH_INTERNAL_URL",
    ...(raw.BMS_SESSION_HOST === "true"
      ? ["WEB_APP_URL", "API_PUBLIC_URL", "PORTAL_URL", "AUTH_PUBLIC_URL"]
      : []),
  ]) {
    if (typeof raw[key] === "string") {
      try {
        const u = new URL(raw[key] as string);
        if (!["http:", "https:"].includes(u.protocol)) invalid.push(key);
      } catch {
        invalid.push(key);
      }
    }
  }
  if (
    raw.SESSION_COOKIE_SECURE !== undefined &&
    !["true", "false"].includes(String(raw.SESSION_COOKIE_SECURE))
  )
    invalid.push("SESSION_COOKIE_SECURE");
  result.SESSION_COOKIE_SECURE = String(raw.SESSION_COOKIE_SECURE) === "true";
  result.TRUST_PROXY_HOPS = Number(raw.TRUST_PROXY_HOPS ?? 1);
  if (
    !Number.isInteger(result.TRUST_PROXY_HOPS) ||
    result.TRUST_PROXY_HOPS < 0 ||
    result.TRUST_PROXY_HOPS > 10
  )
    invalid.push("TRUST_PROXY_HOPS");
  if (
    raw.BMS_BOOKING_HOST === "true" &&
    (typeof raw.CUSTOMER_TRACKING_SECRET !== "string" ||
      raw.CUSTOMER_TRACKING_SECRET.length < 32)
  )
    invalid.push("CUSTOMER_TRACKING_SECRET");
  if (invalid.length)
    throw new Error(
      "Invalid environment names: " + [...new Set(invalid)].join(", "),
    );
  return result;
}
