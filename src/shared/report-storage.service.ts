import { Injectable } from "@nestjs/common";
import { DatabasePool } from "./database-pool";
import pg from "pg";
/** Saved reports use the same BMS-owned analytics PostgreSQL database as its read model. */
@Injectable()
export class ReportStorage {
  private readonly pool: pg.Pool;
  constructor(database: DatabasePool) { this.pool = database.pool; }
  private sql(sql: string) {
    let parameter = 0;
    return sql
      .replace(/\?/g, () => `$${++parameter}`)
      .replace(/CURDATE\(\)/g, "CURRENT_DATE");
  }
  async query<T extends object[] = Record<string, unknown>[]>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T> {
    return (await this.pool.query(this.sql(sql), values)).rows as T;
  }
  async insert(sql: string, values: unknown[] = []) {
    const result = await this.pool.query(
      this.sql(sql) + " RETURNING id",
      values,
    );
    return { insertId: Number(result.rows[0].id) };
  }

}
