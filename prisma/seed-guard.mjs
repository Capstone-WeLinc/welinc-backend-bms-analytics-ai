export function assertSeedAllowed(env = process.env) {
  if (env.NODE_ENV === 'production' && env.SEED_ALLOW !== 'staging') {
    const error=new Error('Seeding is blocked in production; staging seed jobs require SEED_ALLOW=staging');
    error.seedCode='PRODUCTION_SEED_BLOCKED_REQUIRE_STAGING_OVERRIDE';throw error;
  }
}
