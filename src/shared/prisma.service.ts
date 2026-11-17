import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { DatabasePool } from './database-pool';
@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
 constructor(private readonly database: DatabasePool) { super({adapter:new PrismaPg(database.pool,{disposeExternalPool:false})}); }
 async checkReady(){await this.database.ready();}
 async onApplicationShutdown(){await this.$disconnect();}
}
