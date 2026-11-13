import { Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

@Injectable()
export class MySqlService implements OnModuleInit, OnModuleDestroy {
  private pool: mysql.Pool | null = null;
  private readonly connectionOptions: mysql.PoolOptions;
  private readonly database: string;

  constructor(private readonly config: ConfigService) {
    this.database = this.getSafeDatabaseName(
      this.config.get<string>('MYSQL_DATABASE', 'welinc'),
    );
    this.connectionOptions = {
      host: this.config.get<string>('MYSQL_HOST', 'localhost'),
      port: this.config.get<number>('MYSQL_PORT', 8889),
      user: this.config.get<string>('MYSQL_USER', 'root'),
      password: this.config.get<string>('MYSQL_PASSWORD', 'root'),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
    };
  }

  async onModuleInit() {
    const bootstrap = mysql.createPool(this.connectionOptions);
    try {
      // A fresh Windows/MAMP installation may have no `welinc` database yet.
      await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${this.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      this.pool = mysql.createPool({ ...this.connectionOptions, database: this.database });
      await this.ensureReportStorage();
      console.log(`[MySQL] ${this.database}.reports and ai_demand_forecasts are ready.`);
    } catch (error) {
      // Reports are optional. Do not stop the Postgres-backed BMS modules when
      // MAMP/MySQL is offline; report endpoints return a clear 503 instead.
      console.warn('[MySQL] Reports storage is unavailable:', error instanceof Error ? error.message : error);
      if (this.pool) {
        await this.pool.end();
        this.pool = null;
      }
    } finally {
      await bootstrap.end();
    }
  }

  async query<T extends mysql.RowDataPacket[]>(sql: string, values?: mysql.ExecuteValues): Promise<T> {
    if (!this.pool) {
      throw new ServiceUnavailableException('MySQL reports storage is unavailable. Start MAMP MySQL and restart BMS.');
    }
    const [rows] = await this.pool.execute<T>(sql, values);
    return rows;
  }

  async insert(sql: string, values?: mysql.ExecuteValues): Promise<mysql.ResultSetHeader> {
    if (!this.pool) {
      throw new ServiceUnavailableException('MySQL reports storage is unavailable. Start MAMP MySQL and restart BMS.');
    }
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(sql, values);
    return result;
  }

  onModuleDestroy() {
    if (this.pool) {
      void this.pool.end();
      this.pool = null;
    }
  }

  private async ensureReportStorage() {
    if (!this.pool) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        report_type ENUM('daily', 'operational', 'monthly', 'forecast') NOT NULL,
        period_key VARCHAR(255) NOT NULL,
        garage VARCHAR(120) NULL,
        kpis JSON NOT NULL,
        series JSON NOT NULL,
        raw_metrics JSON NULL,
        generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY reports_generated_at_idx (generated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Older local tables may have been created before AI forecasts existed.
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      "SHOW COLUMNS FROM reports LIKE 'report_type'",
    );
    const type = String(rows[0]?.Type ?? '');
    if (type.startsWith('enum(') && !type.includes("'forecast'")) {
      await this.pool.query(
        "ALTER TABLE reports MODIFY report_type ENUM('daily', 'operational', 'monthly', 'forecast') NOT NULL",
      );
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ai_demand_forecasts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        forecast_horizon VARCHAR(20) NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        service_type VARCHAR(120) NULL,
        garage VARCHAR(120) NULL,
        predicted_bookings INT NOT NULL,
        confidence DECIMAL(5,2) NULL,
        forecast_data JSON NOT NULL,
        recommendations JSON NULL,
        summary_text TEXT NULL,
        generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ai_demand_forecasts_generated_at_idx (generated_at),
        KEY ai_demand_forecasts_period_idx (period_start, period_end)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // A confidence score is only stored when an evaluation supports it, so older
    // tables that required one are relaxed to allow NULL.
    const [confidence] = await this.pool.query<mysql.RowDataPacket[]>(
      "SHOW COLUMNS FROM ai_demand_forecasts LIKE 'confidence'",
    );
    if (confidence[0]?.Null === 'NO') {
      await this.pool.query('ALTER TABLE ai_demand_forecasts MODIFY confidence DECIMAL(5,2) NULL');
    }
  }

  private getSafeDatabaseName(value: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
      throw new Error('MYSQL_DATABASE may contain only letters, numbers, and underscores.');
    }
    return value;
  }
}
