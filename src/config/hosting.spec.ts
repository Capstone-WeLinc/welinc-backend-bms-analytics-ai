import { poolMax, hostingIssues, databaseReady } from './hosting';
describe('hosting requirements',()=>{
  it('defaults to two connections and rejects invalid limits',()=>{expect(poolMax(undefined)).toBe(2);expect(poolMax('1')).toBe(1);for(const value of ['0','x','2.5','-1'])expect(()=>poolMax(value)).toThrow('DB_POOL_MAX');});
  it('rejects insecure production addresses without exposing their values',()=>{const errors=hostingIssues({NODE_ENV:'production',AUTH_CLIENT_ID:'bms-analytics',DATABASE_URL:'postgresql://user:secret@localhost/db',AUTH_JWKS_URL:'http://localhost/keys'},true,'bms-analytics',[]);expect(errors).toEqual(expect.arrayContaining(['DATABASE_URL','AUTH_JWKS_URL']));expect(errors.join()).not.toContain('secret');});
  it('requires the correct service identity',()=>{expect(hostingIssues({AUTH_CLIENT_ID:'wrong'},false,'bms-analytics',[])).toContain('AUTH_CLIENT_ID');});
  it('bounds a stalled database probe',async()=>{jest.useFakeTimers();const work=databaseReady(()=>new Promise(()=>{}));const result=expect(work).rejects.toThrow('timeout');await jest.advanceTimersByTimeAsync(2000);await result;jest.useRealTimers();});
});
