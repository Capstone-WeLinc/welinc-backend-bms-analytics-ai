# WeLinc Backend — Analytics & AI (standalone)

Standalone NestJS backend for the WeLinc **Reports & Analytics** feature, including the
**AI Demand Forecast** (Groq LLM, `llama-3.3-70b-versatile`). Copied from the main BMS backend
(`welinc-backend`) — the main backend is unaffected by changes here.

## Endpoints (all require `Authorization: Bearer <jwt>`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/reports/forecast` | AI demand forecast (Groq LLM + deterministic fallback) |
| POST | `/reports/save` | Save a KPI report (MySQL) |
| POST | `/reports/forecast/save` | Save an AI forecast (MySQL) |
| GET | `/reports/saved` | List saved reports/forecasts |
| GET | `/booking` | Bookings data (read-only, for the Reports page) |
| GET | `/vehicles` | Vehicles data (read-only) |
| GET | `/drivers` | Drivers data (read-only) |

## Prerequisites

- Node.js 20+
- **PostgreSQL** reachable at `DATABASE_URL` (same DB as the main BMS — bookings are the analytics input)
- **Docker MySQL** published on host port `3307` (stores saved reports / forecasts; optional at boot — endpoints degrade to 503)
- **`GROQ_API_KEY`** — non-empty (dummy key works; calls then fall back to the deterministic forecast)
- **`JWT_SECRET` must equal the main backend's `welinc-backend/.env` value** — this backend only
  verifies tokens minted by the main backend's `POST /auth/login`

The Analytics Prisma schema is a read-side view of BMS PostgreSQL. Booking assignment
and garage fields come from `scheduled_bookings`; run `npx prisma generate` after
updating this checkout. Apply PostgreSQL migrations from the main BMS backend only.

## Setup & run

```bash
cp .env.example .env    # or copy the main backend's .env and change PORT=3001
npm install
npx prisma generate     # Prisma 7 requires .env to exist first
npm run build
npm start               # http://localhost:3001
```

## Ports

| App | URL |
|---|---|
| Standalone backend (this) | http://localhost:3001 |
| Main BMS backend | http://localhost:3000 |
| Main BMS frontend | http://localhost:5173 |

## Degradation matrix

- Groq unreachable / dummy key → `POST /reports/forecast` returns the deterministic fallback forecast
- Docker MySQL down → `/reports/save`, `/reports/forecast/save`, `/reports/saved` return 503; forecasts still work
- Postgres down → data + forecast endpoints fail (500)

## Tooling

```bash
npm run evaluate:forecast   # backtest saved AI forecasts -> scripts/forecast-accuracy-report.csv
npm run typecheck           # tsc --noEmit
```
