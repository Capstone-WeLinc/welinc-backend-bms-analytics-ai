# BMS Analytics API

NestJS 11 and Prisma 7 on Node 24, using npm. This BMS-owned API runs on 3025
behind the BMS gateway and independently verifies shared auth's BMS tokens.
Use the [BMS setup guide](../docs/context/bms/setup.md) for the whole stack.

Its PostgreSQL database is `bms-analytics-db` (host port 5437). The BMS projection
worker writes booking and assignment read models through BMS internal APIs.
Saved KPI reports, forecasts and evaluations use this same owned database.
Prisma migrations in this repository create the schema. No other system's
database is queried. Vehicles, drivers and helpers come from dispatch, with the
signed-in person's bearer token forwarded unchanged.

| Public path, prefixed with `/bms` | Purpose |
|---|---|
| `/reports/operational` | Operational report, admin only |
| `/reports/resources-snapshot` | Current resources, admin only |
| `/reports/forecast` | Deterministic forecast and resource planning |
| `/reports/forecast/insights` | Optional AI interpretation |
| `/reports/save`, `/reports/forecast/save` | Save reports and forecasts |
| `/reports/saved` | List saved reports and forecasts |
| `/data/booking` | Analytics booking read model |
| `/data/vehicles`, `/data/drivers`, `/data/helpers` | Dispatch resource lists |

Read/list routes use GET; forecast and save routes use POST. All require a
shared BMS access token. `/health/ready` is an internal readiness endpoint.
Account activity is fetched directly from shared auth by the web app.

Compose supplies auth settings from the backend root environment and the owned
database URL. This folder's environment file is for optional `GROQ_API_KEY` and
`GROQ_MODEL`. Keep secret values out of source and logs. Without an AI key,
deterministic forecasts remain available and AI interpretation reports that it
is unconfigured. VMMS must serve its fleet API for live resource planning.

```sh
npm ci
npm run prisma:generate
npm run build
npm run test:auth
npm test
```

With the stack running, from the workspace:

```sh
docker compose -f docker-compose.bms.yml exec -T bms-analytics node --test test/storage-contract.cjs
```

The storage test inserts a uniquely tagged report, verifies PostgreSQL JSON
storage and parameter binding, and removes its own row in cleanup. The seed
command preserves existing data. Forecast evaluation remains available as
`npm run evaluate:forecast` with the owned database configured.
