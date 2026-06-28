-- NJ Realtor MCP — Database Schema
-- PostgreSQL 16 + pgvector extension
-- Run: psql -d nj_realtor -f schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;   -- for geo queries
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- for fuzzy address search

-- ── Properties ───────────────────────────────────────────────────────────────
CREATE TABLE properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Identity
  mls_id          TEXT UNIQUE,
  attom_id        TEXT UNIQUE,
  address         TEXT NOT NULL,
  full_address    TEXT,
  unit            TEXT,
  city            TEXT,
  county          TEXT,
  state           CHAR(2) DEFAULT 'NJ',
  zip             CHAR(5),
  municipality    TEXT,  -- NJ has 565 municipalities, important for tax/zoning
  
  -- Location (PostGIS point for geo queries)
  location        GEOGRAPHY(POINT, 4326),
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  
  -- Property details
  property_type   TEXT,  -- single_family, condo, townhouse, multi_family, land
  beds            SMALLINT,
  baths           NUMERIC(3,1),
  half_baths      SMALLINT DEFAULT 0,
  sqft            INTEGER,
  lot_sqft        INTEGER,
  year_built      SMALLINT,
  stories         SMALLINT,
  garage          BOOLEAN,
  garage_spaces   SMALLINT,
  pool            BOOLEAN,
  basement        TEXT,   -- none, unfinished, finished, partial
  heating         TEXT,
  cooling         TEXT,
  style           TEXT,   -- colonial, ranch, cape_cod, tudor, contemporary, etc.
  
  -- Listing data
  status          TEXT,   -- active, pending, sold, expired, withdrawn
  list_price      BIGINT,
  sold_price      BIGINT,
  list_date       DATE,
  sold_date       DATE,
  days_on_market  SMALLINT,
  list_to_sold_ratio NUMERIC(5,3),
  
  -- NJ specific
  annual_tax      INTEGER,
  tax_year        SMALLINT,
  hoa_fee         INTEGER,
  hoa_freq        TEXT,
  flood_zone      TEXT,   -- FEMA zone code (AE, X, VE, etc.)
  school_district TEXT,
  elementary_school TEXT,
  middle_school   TEXT,
  high_school     TEXT,
  
  -- Content
  description     TEXT,
  features        TEXT[],
  photos          TEXT[],
  virtual_tour_url TEXT,
  
  -- AI enrichment
  embedding       vector(1536),   -- OpenAI text-embedding-3-large
  ai_summary      TEXT,           -- AI-generated property summary
  neighborhood_score SMALLINT,    -- 0-100
  investment_score   SMALLINT,    -- 0-100 (if rental applicable)
  
  -- Meta
  source          TEXT,   -- mls_gsmls, mls_bright, attom, zillow, manual
  raw_data        JSONB,  -- full source record
  crawled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Geo index for radius searches
CREATE INDEX idx_properties_location   ON properties USING GIST(location);
CREATE INDEX idx_properties_status     ON properties(status);
CREATE INDEX idx_properties_zip        ON properties(zip);
CREATE INDEX idx_properties_price      ON properties(list_price, sold_price);
CREATE INDEX idx_properties_updated    ON properties(updated_at DESC);
CREATE INDEX idx_properties_address    ON properties USING GIN(to_tsvector('english', address));
CREATE INDEX idx_properties_embedding  ON properties USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);

-- ── Transaction / Sales History ───────────────────────────────────────────────
CREATE TABLE sales_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID REFERENCES properties(id),
  address         TEXT NOT NULL,
  sale_price      BIGINT,
  sale_date       DATE,
  deed_type       TEXT,
  grantor         TEXT,  -- seller
  grantee         TEXT,  -- buyer
  deed_book       TEXT,
  deed_page       TEXT,
  mortgage_amount BIGINT,
  mortgage_lender TEXT,
  source          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sales_property  ON sales_history(property_id);
CREATE INDEX idx_sales_address   ON sales_history(address);
CREATE INDEX idx_sales_date      ON sales_history(sale_date DESC);

-- ── Tax Assessment History ────────────────────────────────────────────────────
CREATE TABLE tax_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID REFERENCES properties(id),
  address         TEXT NOT NULL,
  municipality    TEXT,
  county          TEXT,
  tax_year        SMALLINT,
  land_value      INTEGER,
  improvement_value INTEGER,
  total_assessed  INTEGER,
  tax_rate        NUMERIC(6,4),  -- per $100 assessed
  annual_tax      INTEGER,
  tax_class       TEXT,
  exemptions      TEXT[],        -- veteran, senior, disabled, homestead
  source          TEXT DEFAULT 'NJ MOD-IV',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tax_property ON tax_assessments(property_id);
CREATE INDEX idx_tax_year     ON tax_assessments(property_id, tax_year DESC);

-- ── Permit & Lien Records ─────────────────────────────────────────────────────
CREATE TABLE permits_liens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID REFERENCES properties(id),
  address         TEXT NOT NULL,
  record_type     TEXT,  -- permit, lien, lis_pendens, judgment, violation
  status          TEXT,  -- open, closed, pending
  description     TEXT,
  amount          BIGINT,
  filed_date      DATE,
  resolved_date   DATE,
  filing_entity   TEXT,
  case_number     TEXT,
  source          TEXT,
  raw_data        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_liens_property ON permits_liens(property_id);
CREATE INDEX idx_liens_type     ON permits_liens(record_type, status);

-- ── Market Stats (aggregated, cached) ────────────────────────────────────────
CREATE TABLE market_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  area_type       TEXT,   -- zip, municipality, county
  area_code       TEXT,   -- zip or name
  property_type   TEXT DEFAULT 'all',
  period_start    DATE,
  period_end      DATE,
  
  -- Metrics
  active_count    INTEGER,
  sold_count      INTEGER,
  median_list     INTEGER,
  median_sold     INTEGER,
  avg_dom         NUMERIC(5,1),
  list_to_sold    NUMERIC(5,3),
  months_supply   NUMERIC(4,1),
  price_per_sqft  INTEGER,
  yoy_change      NUMERIC(5,2),  -- % change vs same period last year
  
  -- Source
  source          TEXT,
  computed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_market_area_period ON market_stats(area_type, area_code, property_type, period_start);

-- ── Clients / Buyer Profiles ──────────────────────────────────────────────────
CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  type            TEXT DEFAULT 'buyer',  -- buyer, seller, investor, renter
  
  -- Search criteria (stored as JSONB for flexibility)
  criteria        JSONB,
  
  -- Alert preferences
  alert_enabled   BOOLEAN DEFAULT true,
  alert_channels  TEXT[] DEFAULT ARRAY['sms'],
  alert_frequency TEXT DEFAULT 'instant',  -- instant, daily, weekly
  
  -- Agent notes
  notes           TEXT,
  tags            TEXT[],
  
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Showings ─────────────────────────────────────────────────────────────────
CREATE TABLE showings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID REFERENCES properties(id),
  client_id       UUID REFERENCES clients(id),
  address         TEXT,
  scheduled_at    TIMESTAMPTZ,
  duration_mins   SMALLINT DEFAULT 30,
  status          TEXT DEFAULT 'confirmed',  -- confirmed, cancelled, completed
  gcal_event_id   TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── NJ ZIP Code Reference ─────────────────────────────────────────────────────
CREATE TABLE nj_zips (
  zip             CHAR(5) PRIMARY KEY,
  city            TEXT,
  municipality    TEXT,
  county          TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  nj_transit_line TEXT[],  -- e.g. ['NEC', 'North Jersey Coast']
  nearest_station TEXT,
  station_miles   NUMERIC(4,1),
  -- NJ-specific
  shore_community BOOLEAN DEFAULT false,
  rent_control    BOOLEAN DEFAULT false,
  dfg             TEXT,    -- District Factor Group (school quality proxy)
  avg_tax_rate    NUMERIC(5,3)
);

-- ── Crawl Job Queue ───────────────────────────────────────────────────────────
CREATE TABLE crawl_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  job_type        TEXT,   -- listing, tax_record, permit, flood, rental_comp
  status          TEXT DEFAULT 'pending',  -- pending, running, done, failed
  priority        SMALLINT DEFAULT 5,
  attempts        SMALLINT DEFAULT 0,
  max_attempts    SMALLINT DEFAULT 3,
  payload         JSONB,
  result          JSONB,
  error           TEXT,
  scheduled_at    TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_crawl_pending ON crawl_jobs(status, priority DESC, scheduled_at) WHERE status = 'pending';

-- ── Vector search function ────────────────────────────────────────────────────
-- Semantic similarity search for "find me something like this property"
CREATE OR REPLACE FUNCTION find_similar_properties(
  query_embedding vector(1536),
  area_zip TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 10
)
RETURNS TABLE(id UUID, address TEXT, similarity FLOAT, list_price BIGINT, beds SMALLINT, baths NUMERIC, sqft INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT 
    p.id,
    p.address,
    1 - (p.embedding <=> query_embedding) AS similarity,
    p.list_price,
    p.beds,
    p.baths,
    p.sqft
  FROM properties p
  WHERE 
    p.status = 'active'
    AND p.embedding IS NOT NULL
    AND (area_zip IS NULL OR p.zip = area_zip)
  ORDER BY p.embedding <=> query_embedding
  LIMIT result_limit;
$$;

-- ── Trigger: update updated_at ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_properties_updated BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_clients_updated BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
