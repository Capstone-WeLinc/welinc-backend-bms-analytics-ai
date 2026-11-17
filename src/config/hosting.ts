export function poolMax(value: unknown): number {
  const n = value === undefined || String(value).trim() === '' ? 2 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Invalid environment name: DB_POOL_MAX');
  return n;
}
const local = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0';
export function hostingIssues(raw: Record<string, unknown>, database: boolean, clientId: string, upstreams: string[]): string[] {
  const errors: string[] = [];
  if (raw.AUTH_CLIENT_ID !== clientId) errors.push('AUTH_CLIENT_ID');
  if (database) {
    try { poolMax(raw.DB_POOL_MAX); } catch { errors.push('DB_POOL_MAX'); }
    try {
      const db = new URL(String(raw.DATABASE_URL ?? ''));
      if (!['postgres:', 'postgresql:'].includes(db.protocol)) errors.push('DATABASE_URL');
      if (raw.NODE_ENV === 'production' && (local(db.hostname) || !['require','verify-ca','verify-full'].includes(db.searchParams.get('sslmode') ?? ''))) errors.push('DATABASE_URL');
    } catch { errors.push('DATABASE_URL'); }
  }
  if (raw.NODE_ENV !== 'production') return errors;
  for (const name of upstreams) if (typeof raw[name] !== 'string' || !String(raw[name]).trim()) errors.push(name);
  const names = ['AUTH_ISSUER','AUTH_JWKS_URL','AUTH_INTERNAL_URL','AUTH_PUBLIC_URL','API_PUBLIC_URL','PORTAL_URL','WEB_APP_URL','BOOKING_API_URL','DISPATCH_API_URL','COMPLETION_API_URL','ANALYTICS_API_URL','ANALYTICS_PROJECTION_URL','VMMS_INTERNAL_URL'];
  for (const name of names) {
    if (!raw[name]) continue;
    try { const url = new URL(String(raw[name])); if (url.protocol !== 'https:' || local(url.hostname)) errors.push(name); }
    catch { errors.push(name); }
  }
  for (const origin of String(raw.CORS_ORIGINS ?? '').split(',').map(s=>s.trim()).filter(Boolean)) {
    try { const url=new URL(origin); if(url.origin !== origin || url.protocol !== 'https:' || local(url.hostname)) errors.push('CORS_ORIGINS'); }
    catch { errors.push('CORS_ORIGINS'); }
  }
  if (raw.BMS_SESSION_HOST === 'true' && (String(raw.SESSION_COOKIE_SECURE) !== 'true' || Number(raw.TRUST_PROXY_HOPS ?? 0) < 1)) errors.push('SESSION_COOKIE_SECURE','TRUST_PROXY_HOPS');
  return errors;
}
export async function databaseReady(ping: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([ping(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Database readiness timeout')),2000);})]); }
  finally { if(timer)clearTimeout(timer); }
}
