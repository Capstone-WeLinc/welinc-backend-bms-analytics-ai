const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {ReportStorage}=require('../dist/src/shared/report-storage.service.js');
test('saved reports use real PostgreSQL JSON storage and parameter binding',async()=>{
  const storage=new ReportStorage({getOrThrow:()=>process.env.DATABASE_URL});
  const period='integration-'+randomUUID();let id;
  try{
    const saved=await storage.insert('INSERT INTO reports(report_type,period_key,kpis,series) VALUES(?,?,?,?)',['daily',period,JSON.stringify({bookings:2}),JSON.stringify([{day:'test',value:2}])]);id=saved.insertId;
    const rows=await storage.query('SELECT period_key,kpis,series FROM reports WHERE id=?',[id]);assert.equal(rows[0].period_key,period);assert.deepEqual(rows[0].kpis,{bookings:2});assert.equal(rows[0].series[0].value,2);
    const tables=await storage.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','user_roles','user_activity_logs','vehicles','drivers','garages')");assert.equal(tables.length,0);
  }finally{if(id)await storage.query('DELETE FROM reports WHERE id=?',[id]);await storage.onModuleDestroy();}
});
