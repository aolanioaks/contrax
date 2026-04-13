CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'image', 'text')),
  original_filename TEXT,
  customer_email TEXT,
  contract_text TEXT NOT NULL,
  summary TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  risk_score NUMERIC(3,1) NOT NULL,
  top_risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  flagged_clauses JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_protections JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_recommendation TEXT NOT NULL,
  unlocked BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_checkout_session_id TEXT,
  stripe_payment_status TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reports_created_at_idx ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS reports_checkout_idx ON reports(stripe_checkout_session_id);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_status TEXT,
  amount_cents INTEGER,
  currency TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reports_touch_updated_at ON reports;
CREATE TRIGGER reports_touch_updated_at
BEFORE UPDATE ON reports
FOR EACH ROW
EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS payments_touch_updated_at ON payments;
CREATE TRIGGER payments_touch_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW
EXECUTE FUNCTION touch_updated_at();
