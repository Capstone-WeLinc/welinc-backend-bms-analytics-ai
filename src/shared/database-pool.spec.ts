import { DatabasePool } from './database-pool';
import { ReportStorage } from './report-storage.service';
import { PrismaService } from './prisma.service';
describe('whole-process analytics budget',()=>{
 it('shares one capped pool between Prisma and report SQL',async()=>{
  const db=new DatabasePool({getOrThrow:()=> 'postgresql://test:test@localhost/test',get:()=>2} as any);
  const reports=new ReportStorage(db);const prisma=new PrismaService(db);
  expect((reports as any).pool).toBe(db.pool);expect((db.pool as any).options.max).toBe(2);
  await prisma.$disconnect();await db.onApplicationShutdown();
 });
});
