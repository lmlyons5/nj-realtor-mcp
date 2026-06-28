# NJ Realtor MCP — Frontier Edition

A production-grade Model Context Protocol server for NJ real estate agents.  
20 tools. 15+ data sources. Crawl4AI web crawling. Deep research mode. Full NJ-specific intelligence.

---

## What This Does

Claude gains 20 native tools covering the full NJ real estate workflow:

| Category | Tools |
|---|---|
| **Search & Discovery** | `search_listings`, `similar_homes`, `foreclosure_radar` |
| **Valuation** | `generate_cma`, `price_history`, `tax_assessment_lookup` |
| **Intelligence** | `neighborhood_report`, `school_district_report`, `flood_risk_report`, `commute_analysis` |
| **Investment** | `investment_analysis`, `rental_comps`, `mortgage_calculator` |
| **Agent Tools** | `draft_listing`, `schedule_showing`, `client_match`, `send_client_alert` |
| **Market Data** | `market_pulse`, `permit_lien_lookup` |
| **Research** | `deep_research` (orchestrated multi-step AI research) |

---

## Data Sources (Full Map)

### MLS / Listing Data
| Source | What | How |
|---|---|---|
| GSMLS (Garden State MLS) | NJ's largest MLS — Bergen, Essex, Morris, Union, Passaic, Hudson, Somerset, Sussex, Warren | RESO Web API (OAuth2) |
| Bright MLS | South Jersey — Camden, Burlington, Atlantic, Cape May, Cumberland, Salem, Gloucester | Bright MLS API |
| Zillow | Zestimate, price history, public listing details | Crawl4AI (Playwright) |
| Redfin | Market trends, sold data CSVs, DOM stats | CSV export + Crawl4AI |
| Realtor.com | Competing listings, agent data | Crawl4AI |

### Public Records (NJ-Specific)
| Source | What | How |
|---|---|---|
| NJ MOD-IV | Statewide property tax assessment database (all 565 municipalities) | Annual bulk download + API |
| NJ Courts Portal | Lis pendens, tax liens, judgments, foreclosures | Crawl4AI (PACER-style search) |
| NJ DEP GIS | Flood hazard delineations, wetlands, brownfields, contamination sites | ArcGIS REST API |
| NJ Flood Mapper | FEMA flood zones, base flood elevation, advisory maps | Crawl4AI |
| County Clerk portals | Deed records, mortgage filings (20 NJ counties each have own portal) | Crawl4AI per county |
| NJ OpenData | Municipal boundaries, zoning, permits, demographics | Socrata API (data.nj.gov) |

### Neighborhood Intelligence
| Source | What | How |
|---|---|---|
| US Census ACS | Income, age, education, race, housing tenure (block group level) | Census API (free, key required) |
| GreatSchools | School ratings 1-10, test scores, enrollment | GreatSchools API |
| NJ DOE Report Card | District Factor Group (DFG), NJSLA scores, graduation rates | NJ OpenData / Crawl4AI |
| Walk Score | Walkability, transit score, bike score | Walk Score API |
| SpotCrime | Neighborhood crime incidents (0.5mi radius) | Crawl4AI / SpotCrime API |
| Google Places | Nearby grocery, restaurants, hospitals, parks, gyms | Google Maps Platform |

### Market & Financial
| Source | What | How |
|---|---|---|
| FRED (Federal Reserve) | 30yr/15yr mortgage rates, housing price index, CPI | FRED API (free) |
| ATTOM Data | Property deed/mortgage history, foreclosure data, AVM | ATTOM API (paid) |
| HouseCanary | Property-level AVM, market analytics, risk scores | HouseCanary API (paid) |
| Freddie Mac PMMS | Weekly primary mortgage market survey | Public Excel download |
| Apartments.com | Active rental listings for rental comp analysis | Crawl4AI |
| Rentometer | Rental comp benchmark | Rentometer API |

### Transit / Commute
| Source | What | How |
|---|---|---|
| NJ Transit GTFS | Train/bus static schedules (rail lines: NEC, NJCL, Montclair-Boonton, Morris-Essex, Raritan Valley, etc.) | Public GTFS feed |
| NJ Transit Real-Time | Live train delays, cancellations | NJ Transit Vision API |
| Google Maps Platform | Driving times, traffic, transit routing | Maps API |
| PATH (Port Authority) | Hudson County to NYC subway times | GTFS |

### Communications & Calendar
| Source | What | How |
|---|---|---|
| Twilio | SMS showing confirmations, client property alerts | Twilio API |
| SendGrid | Email CMAs (PDF), market digest newsletters | SendGrid API |
| Google Calendar | Showing scheduling, availability check | Google Calendar API (OAuth2) |

---

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+
- API keys (see `.env.example`)

### 1. Clone and configure
```bash
git clone <repo>
cd nj-realtor-mcp
cp .env.example .env
# Edit .env with your API keys
```

### 2. Start the full stack
```bash
cd docker
docker compose up -d
```

This starts:
- **PostgreSQL 16** with pgvector + PostGIS (geo queries + semantic search)
- **Redis** (caching + job queue)  
- **Crawl4AI** (async browser-based crawler with anti-bot mode)
- **MCP Server** (the 20 tools)
- **Cron service** (background data sync)

### 3. Initialize the database
```bash
docker exec nj_realtor_db psql -U realtor -d nj_realtor -f /docker-entrypoint-initdb.d/01_schema.sql
node scripts/seed_nj_zips.js   # seeds all NJ ZIP codes with county, transit, tax rate data
```

### 4. Seed MLS data
```bash
node scripts/seed_crawl.js   # queues initial crawl jobs for NJ listings
```

### 5. Register with Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "nj-realtor": {
      "command": "node",
      "args": ["/path/to/nj-realtor-mcp/src/index.js"],
      "env": {
        "POSTGRES_URL": "postgresql://realtor:pass@localhost:5432/nj_realtor",
        "REDIS_URL": "redis://localhost:6379",
        "CRAWL4AI_URL": "http://localhost:11235"
      }
    }
  }
}
```

---

## Example Claude Conversations

### Property Due Diligence
> "Run deep research on 47 Oak Avenue, Rumson NJ 07760"

Claude will: pull price history, run CMA, check permits/liens, assess flood risk, analyze commute to NYC, pull school district data, check for rent control (not applicable for SFR), and synthesize into a full due diligence report.

### Buyer Matching
> "I have a new buyer, Sarah Chen, looking for a 3-4BR under $750k in Monmouth County with good schools and under 60 min train to NYC. Set up alerts."

Claude will: save buyer profile, search active listings, rank by match score, send initial SMS with top 5 matches, and enable ongoing alerts for new listings.

### Investment Analysis
> "Analyze 22 Main St, Asbury Park NJ as a rental investment. Purchase price $620k."

Claude will: estimate market rent (Asbury Park has strong rental demand + rent control), run full NOI/cap rate/cash-on-cash analysis, flag NJ's high property tax rate, check for rent control, and calculate 5-year IRR.

### Market Report
> "Give me a market pulse for Monmouth County for the last 30 days"

Claude will: pull median prices, DOM, inventory, list-to-sold ratios, YoY changes, and write a 3-sentence market narrative for your newsletter.

### Listing Copy
> "Draft a listing for 8 Harbor View Dr, Sea Bright NJ. Highlights: oceanfront, fully renovated, elevator, 4BR, $3.2M."

Claude will: generate MLS description (500 words), Instagram caption, Facebook post, and 5 key feature bullets — all optimized for waterfront luxury segment.

---

## NJ-Specific Intelligence

This MCP was built with deep NJ market knowledge baked in:

- **Property taxes**: NJ has the highest effective rate in the US (avg 2.23%). Every valuation and investment analysis explicitly accounts for this.
- **Flood risk**: Post-Hurricane Sandy, flood zone classification is critical for NJ coastal/shore properties (Ocean, Monmouth, Atlantic counties especially). We integrate FEMA + NJ DEP + sea level rise projections.
- **School districts**: NJ's #1 buyer decision factor. We integrate NJ DOE District Factor Groups (A through J), NJSLA scores, and GreatSchools ratings.
- **NJ Transit**: Door-to-door commute time to NYC Penn Station is a core value driver. We compute actual train journey times for 163 NJ rail stations.
- **Rent control**: ~100 NJ municipalities have rent control. Every investment analysis flags this automatically.
- **565 municipalities**: Each has its own tax rate, zoning rules, and permit system. Our tax lookup normalizes across all of them.
- **Mansion tax**: NJ imposes a 1% mansion tax on residential sales over $1M. Our mortgage and investment calculators include this.
- **Landlord-tenant law**: NJ is tenant-friendly (Anti-Eviction Act). Investment analyses note this risk.

---

## Architecture

```
Claude Desktop
    │
    ▼ MCP (stdio)
NJ Realtor MCP Server (Node.js)
    │
    ├── PostgreSQL 16 + pgvector + PostGIS
    │       ├── properties table (MLS + ATTOM merged)
    │       ├── sales_history (deed records)
    │       ├── tax_assessments (NJ MOD-IV)
    │       ├── permits_liens (NJ Courts + municipal)
    │       ├── market_stats (pre-aggregated)
    │       ├── clients (buyer profiles + alert criteria)
    │       └── crawl_jobs (queue for background crawling)
    │
    ├── Redis (6hr TTL cache for CMAs, neighborhood reports)
    │
    └── Crawl4AI (Docker, Playwright-based)
            ├── Zillow property pages
            ├── NJ county tax/deed portals (20 counties)
            ├── NJ Courts lis pendens search
            ├── NJ Flood Mapper
            ├── Apartments.com rental listings
            ├── NJ Transit schedule pages
            └── SpotCrime crime data
```

---

## Roadmap

- [ ] Matterport 3D tour integration (auto-generate for listed properties)
- [ ] NJ short-term rental ordinance tracker (Airbnb viability by municipality)
- [ ] HOA document analyzer (AI reads CC&Rs and flags red flags)
- [ ] Contractor permit history (who pulled permits, licensed/unlicensed work)
- [ ] Solar potential analysis (NJ has strong solar incentives — SREC program)
- [ ] 1031 exchange tracker (identify replacement properties meeting exchange criteria)
- [ ] MLS listing auto-publish (post approved listings directly to GSMLS)
- [ ] Offer analysis tool (compare multiple offers with net-to-seller calculation)
- [ ] Property condition report parser (AI reads inspection reports, extracts issues)
- [ ] NJ ANCHOR benefit calculator (NJ property tax relief program for homeowners)
