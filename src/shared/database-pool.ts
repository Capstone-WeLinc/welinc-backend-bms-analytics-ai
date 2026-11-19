import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import { poolMax, databaseReady } from '../config/hosting';

/** One pool owns the entire process budget; Prisma and report SQL borrow it. */
@Injectable()
export class DatabasePool implements OnApplicationShutdown {
 readonly pool: pg.Pool;
 constructor(config: ConfigService) {
  this.pool=new pg.Pool({connectionString:config.getOrThrow<string>('DATABASE_URL'),max:poolMax(config.get('DB_POOL_MAX')),connectionTimeoutMillis:1900});
  this.pool.on('error',()=>console.error('Database pool connection closed'));
 }
 async ready(){await databaseReady(()=>{const query={text:'SELECT 1',query_timeout:1900};return this.pool.query(query);});}
 async onApplicationShutdown(){await this.pool.end();}
}
