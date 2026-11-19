CREATE TABLE reports (
id SERIAL PRIMARY KEY, report_type VARCHAR(30) NOT NULL, period_key VARCHAR(255) NOT NULL, garage VARCHAR(120),
kpis JSONB NOT NULL, series JSONB NOT NULL, raw_metrics JSONB, generated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX reports_generated_at_idx ON reports(generated_at);
CREATE TABLE ai_demand_forecasts (
id SERIAL PRIMARY KEY, forecast_horizon VARCHAR(20) NOT NULL, period_start DATE NOT NULL, period_end DATE NOT NULL,
service_type VARCHAR(120), garage VARCHAR(120), predicted_bookings INT NOT NULL, confidence DECIMAL(5,2),
forecast_data JSONB NOT NULL, recommendations JSONB, summary_text TEXT, generated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX ai_demand_forecasts_generated_at_idx ON ai_demand_forecasts(generated_at);
CREATE INDEX ai_demand_forecasts_period_idx ON ai_demand_forecasts(period_start,period_end);
