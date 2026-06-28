/**
 * NJ Realtor MCP Server — Frontier Edition
 * 
 * Exposes 20+ tools covering: MLS search, CMA generation, neighborhood
 * intelligence, investment analysis, listing drafting, market pulse,
 * deep research mode, permit/lien lookup, flood risk, commute analysis,
 * client matching, showing scheduling, and weekly digests.
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './utils/logger.js';
import { db } from './data/db.js';
import { cache } from './data/cache.js';

// ── Tool handlers ────────────────────────────────────────────────────────────
import { searchListings }        from './tools/search_listings.js';
import { generateCMA }           from './tools/generate_cma.js';
import { neighborhoodReport }    from './tools/neighborhood_report.js';
import { investmentAnalysis }    from './tools/investment_analysis.js';
import { draftListing }          from './tools/draft_listing.js';
import { scheduleShowing }       from './tools/schedule_showing.js';
import { clientMatch }           from './tools/client_match.js';
import { marketPulse }           from './tools/market_pulse.js';
import { deepResearch }          from './tools/deep_research.js';
import { permitLienLookup }      from './tools/permit_lien_lookup.js';
import { floodRiskReport }       from './tools/flood_risk_report.js';
import { commuteAnalysis }       from './tools/commute_analysis.js';
import { priceHistory }          from './tools/price_history.js';
import { foreclosureRadar }      from './tools/foreclosure_radar.js';
import { schoolDistrictReport }  from './tools/school_district_report.js';
import { mortgageCalculator }    from './tools/mortgage_calculator.js';
import { rentalComps }           from './tools/rental_comps.js';
import { taxAssessmentLookup }   from './tools/tax_assessment.js';
import { similarHomes }          from './tools/similar_homes.js';
import { sendClientAlert }       from './tools/send_client_alert.js';

// ── Tool manifest ────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_listings',
    description: `Search active NJ MLS listings. Supports natural language filters:
      price range, beds/baths, ZIP codes, towns, school districts, property type,
      days on market, lot size, garage, pool, waterfront, commute constraints.
      Returns ranked results with AVM confidence, neighborhood score, and flood risk flag.`,
    inputSchema: {
      type: 'object',
      properties: {
        query:          { type: 'string',  description: 'Natural language search e.g. "4BR under $800k in Rumson with good schools"' },
        zip_codes:      { type: 'array',   items: { type: 'string' }, description: 'NJ ZIP codes to filter' },
        min_price:      { type: 'number' },
        max_price:      { type: 'number' },
        min_beds:       { type: 'integer' },
        min_baths:      { type: 'number' },
        property_type:  { type: 'string',  enum: ['single_family', 'condo', 'townhouse', 'multi_family', 'land', 'commercial'] },
        max_dom:        { type: 'integer', description: 'Max days on market' },
        waterfront:     { type: 'boolean' },
        garage:         { type: 'boolean' },
        max_commute_mins: { type: 'integer', description: 'Max commute to NYC Penn Station via NJ Transit' },
        limit:          { type: 'integer', default: 10 },
        sort_by:        { type: 'string',  enum: ['price_asc', 'price_desc', 'dom_asc', 'newest', 'best_value'] },
      },
    },
  },
  {
    name: 'generate_cma',
    description: `Generate a Comparative Market Analysis for any NJ address.
      Pulls 5–15 recent sold comps within 0.5–1 mile, adjusts for beds/baths/sqft/lot/age/condition,
      runs a hedonic regression, and returns a valuation range with confidence interval.
      Includes list-to-sold price ratios and average DOM for the micro-market.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address:        { type: 'string',  description: 'Full NJ property address' },
        radius_miles:   { type: 'number',  default: 0.5 },
        months_back:    { type: 'integer', default: 6, description: 'How far back to pull comps' },
        include_active: { type: 'boolean', default: true },
        output_format:  { type: 'string',  enum: ['json', 'pdf', 'markdown'], default: 'markdown' },
      },
    },
  },
  {
    name: 'neighborhood_report',
    description: `Full neighborhood intelligence for any NJ address or ZIP code.
      Covers: school ratings (GreatSchools + NJ DOE), crime index (SpotCrime),
      walkability/bike/transit scores, flood zone (FEMA + NJ DEP), demographics
      (Census ACS), income levels, age distribution, nearby amenities, and a
      12-month market trend summary.`,
    inputSchema: {
      type: 'object',
      required: ['address_or_zip'],
      properties: {
        address_or_zip: { type: 'string' },
        sections:       { type: 'array', items: { type: 'string',
          enum: ['schools', 'crime', 'walkability', 'flood', 'demographics', 'market', 'amenities', 'all'] },
          default: ['all'] },
      },
    },
  },
  {
    name: 'investment_analysis',
    description: `Investment underwriting for NJ rental properties.
      Calculates: gross rent multiplier, cap rate, cash-on-cash return, NOI,
      DSCR, 5-year IRR projection, vacancy-adjusted income, and BreakEven occupancy.
      Pulls rental comps from Zillow/Apartments.com/Rentometer for income estimate.
      Factors in NJ property tax rates (one of highest in US — critical input).`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address:         { type: 'string' },
        purchase_price:  { type: 'number' },
        down_pct:        { type: 'number', default: 20 },
        interest_rate:   { type: 'number', description: 'Override rate; defaults to current 30yr fixed from FRED' },
        monthly_rent:    { type: 'number', description: 'Override rent; defaults to rental comp estimate' },
        vacancy_rate:    { type: 'number', default: 5 },
        mgmt_fee_pct:    { type: 'number', default: 8 },
        capex_reserve:   { type: 'number', default: 1200, description: 'Annual CapEx reserve $' },
      },
    },
  },
  {
    name: 'draft_listing',
    description: `Generate compelling MLS listing copy and social media posts
      from property details. Writes headline, description (250/500/1000 word variants),
      5 key features bullets, Instagram caption, and Facebook post.
      Tone-matched to luxury, starter, investment, or family segments.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address:      { type: 'string' },
        highlights:   { type: 'array', items: { type: 'string' }, description: 'Agent notes e.g. ["renovated kitchen", "backs to preserve"]' },
        segment:      { type: 'string', enum: ['luxury', 'family', 'starter', 'investment', 'waterfront', 'historic'] },
        word_count:   { type: 'integer', enum: [250, 500, 1000], default: 500 },
      },
    },
  },
  {
    name: 'schedule_showing',
    description: `Schedule a property showing. Creates Google Calendar event,
      sends SMS confirmation to buyer via Twilio, and emails showing instructions.
      Checks agent availability and auto-suggests 3 open slots if requested time conflicts.`,
    inputSchema: {
      type: 'object',
      required: ['address', 'buyer_phone', 'preferred_datetime'],
      properties: {
        address:            { type: 'string' },
        buyer_name:         { type: 'string' },
        buyer_phone:        { type: 'string' },
        buyer_email:        { type: 'string' },
        preferred_datetime: { type: 'string', description: 'ISO 8601 datetime' },
        duration_mins:      { type: 'integer', default: 30 },
        notes:              { type: 'string' },
      },
    },
  },
  {
    name: 'client_match',
    description: `Match a buyer's criteria against all active listings and return
      ranked matches with a match score (0–100) explaining why each property fits.
      Stores buyer profile for ongoing alert monitoring.`,
    inputSchema: {
      type: 'object',
      required: ['buyer_name'],
      properties: {
        buyer_name:       { type: 'string' },
        buyer_phone:      { type: 'string' },
        criteria:         { type: 'object', description: 'Same fields as search_listings' },
        save_profile:     { type: 'boolean', default: true },
        alert_on_new:     { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'market_pulse',
    description: `Weekly NJ real estate market snapshot by county, town, or ZIP.
      Returns: median list price, median sold price, list-to-sold ratio, median DOM,
      active inventory, months of supply, YoY price change, absorption rate,
      and a 3-sentence AI market narrative. Data sourced from MLS + Redfin + ATTOM.`,
    inputSchema: {
      type: 'object',
      properties: {
        area:      { type: 'string', description: 'County, town, or ZIP e.g. "Monmouth County" or "07701"' },
        segments:  { type: 'array', items: { type: 'string' }, description: 'Property types to break out' },
        weeks:     { type: 'integer', default: 4, description: 'Rolling window in weeks' },
      },
    },
  },
  {
    name: 'deep_research',
    description: `Orchestrated multi-step research on any NJ real estate topic.
      Claude plans and executes: web crawling, MLS queries, public records lookups,
      regulatory checks, and synthesizes into a structured report.
      Use for: due diligence on a specific property, market entry analysis for a town,
      competitive listing analysis, or investor underwriting packages.`,
    inputSchema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic:        { type: 'string', description: 'Research question or property address' },
        depth:        { type: 'string', enum: ['quick', 'standard', 'exhaustive'], default: 'standard' },
        output_format:{ type: 'string', enum: ['markdown', 'pdf', 'json'], default: 'markdown' },
      },
    },
  },
  {
    name: 'permit_lien_lookup',
    description: `Check NJ property for open building permits, code violations,
      unpaid tax liens, lis pendens (foreclosure filings), and municipal court judgments.
      Aggregates data from NJ courts portal, county tax records, and municipal permit systems.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string' } },
    },
  },
  {
    name: 'flood_risk_report',
    description: `Detailed flood risk assessment using FEMA NFIP flood maps,
      NJ DEP flood hazard delineations, historical flood events (NOAA),
      sea level rise projections (Rutgers Climate Institute), and NJ Flood Mapper data.
      Returns FEMA flood zone, base flood elevation, insurance cost estimate,
      and 30-year climate risk trajectory. Critical for NJ coastal/shore properties.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address:          { type: 'string' },
        include_insurance_estimate: { type: 'boolean', default: true },
        include_sea_level_projection: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'commute_analysis',
    description: `Analyze commute from any NJ address to multiple destinations.
      Covers: NJ Transit train/bus (live schedules + GTFS), PATH, ferry, driving (Google Maps).
      Returns door-to-door time by mode, cost/month, and "commute score" for NYC, Newark,
      Jersey City, Hoboken, Princeton, and custom destinations.`,
    inputSchema: {
      type: 'object',
      required: ['origin_address'],
      properties: {
        origin_address:  { type: 'string' },
        destinations:    { type: 'array', items: { type: 'string' }, default: ['NYC Penn Station', 'Newark Penn Station', 'Jersey City'] },
        depart_time:     { type: 'string', description: 'Typical departure e.g. "8:00 AM weekday"' },
      },
    },
  },
  {
    name: 'price_history',
    description: `Full transaction and price history for any NJ property.
      Includes: all recorded sales (deed), assessment history, tax history,
      prior MLS listing history (if available), and a price appreciation chart.
      Sources: ATTOM, county deed records, NJ tax assessment database.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address:     { type: 'string' },
        years_back:  { type: 'integer', default: 20 },
      },
    },
  },
  {
    name: 'foreclosure_radar',
    description: `Scan NJ for foreclosure opportunities in a given area.
      Returns: pre-foreclosures (lis pendens), REO listings, sheriff sales (NJ auctions),
      distressed properties with high equity. Filters by equity %, property type, price.`,
    inputSchema: {
      type: 'object',
      properties: {
        area:        { type: 'string' },
        stage:       { type: 'string', enum: ['pre_foreclosure', 'auction', 'reo', 'all'], default: 'all' },
        min_equity:  { type: 'number', default: 20, description: 'Minimum estimated equity %' },
        max_price:   { type: 'number' },
      },
    },
  },
  {
    name: 'school_district_report',
    description: `Deep school district analysis for NJ (one of most school-driven markets in US).
      Returns: NJ DOE report card grades, DFG (District Factor Group), NJSLA scores,
      graduation rates, student-teacher ratio, per-pupil spending, AP/IB programs,
      sports, extracurriculars, and 5-year trend. Compares against county and state averages.`,
    inputSchema: {
      type: 'object',
      required: ['district_or_address'],
      properties: { district_or_address: { type: 'string' } },
    },
  },
  {
    name: 'mortgage_calculator',
    description: `NJ mortgage scenarios with current live rates from FRED/Optimal Blue.
      Calculates P&I, PMI, property tax estimate, homeowner's insurance, HOA.
      Returns full PITI breakdown, amortization schedule, and break-even rent-vs-buy analysis.`,
    inputSchema: {
      type: 'object',
      required: ['purchase_price'],
      properties: {
        purchase_price: { type: 'number' },
        down_payment:   { type: 'number' },
        down_pct:       { type: 'number' },
        loan_type:      { type: 'string', enum: ['conventional_30', 'conventional_15', 'fha', 'va', 'jumbo'], default: 'conventional_30' },
        address:        { type: 'string', description: 'For NJ property tax lookup' },
        credit_score:   { type: 'integer', default: 740 },
      },
    },
  },
  {
    name: 'rental_comps',
    description: `Rental market analysis for any NJ address.
      Pulls active and recently leased rental comps from Zillow, Apartments.com,
      Rentometer, and MLS rentals. Returns market rent estimate by unit type,
      vacancy rate, rent growth trend, and comparable listings.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address:      { type: 'string' },
        unit_type:    { type: 'string', enum: ['studio', '1br', '2br', '3br', '4br+', 'sfr'] },
        radius_miles: { type: 'number', default: 1 },
      },
    },
  },
  {
    name: 'tax_assessment_lookup',
    description: `NJ property tax assessment lookup. Returns current assessed value,
      last year's tax bill, effective tax rate, tax class, exemptions (veteran, senior),
      assessment-to-market ratio, and historical assessment trend.
      NJ has 565 separate municipalities each with own tax rates — this normalizes all of them.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string' } },
    },
  },
  {
    name: 'similar_homes',
    description: `Semantic similarity search: find NJ properties most similar to a given
      property or natural language description using vector embeddings.
      Useful for: "find me something like 123 Oak but in a different town",
      "find listings that feel like this description", portfolio matching.`,
    inputSchema: {
      type: 'object',
      properties: {
        reference_address: { type: 'string' },
        description:       { type: 'string', description: 'Natural language property description' },
        area:              { type: 'string' },
        limit:             { type: 'integer', default: 10 },
      },
    },
  },
  {
    name: 'send_client_alert',
    description: `Send a personalized property alert to a client via SMS and/or email.
      Includes property summary, photos link, price, key stats, and a "Schedule Showing" CTA link.`,
    inputSchema: {
      type: 'object',
      required: ['client_phone_or_email', 'listing_address'],
      properties: {
        client_phone_or_email: { type: 'string' },
        listing_address:       { type: 'string' },
        personal_note:         { type: 'string', description: 'Agent note to personalize the alert' },
        channels:              { type: 'array', items: { type: 'string', enum: ['sms', 'email'] }, default: ['sms', 'email'] },
      },
    },
  },
];

// ── Router ───────────────────────────────────────────────────────────────────
const TOOL_HANDLERS = {
  search_listings:        searchListings,
  generate_cma:           generateCMA,
  neighborhood_report:    neighborhoodReport,
  investment_analysis:    investmentAnalysis,
  draft_listing:          draftListing,
  schedule_showing:       scheduleShowing,
  client_match:           clientMatch,
  market_pulse:           marketPulse,
  deep_research:          deepResearch,
  permit_lien_lookup:     permitLienLookup,
  flood_risk_report:      floodRiskReport,
  commute_analysis:       commuteAnalysis,
  price_history:          priceHistory,
  foreclosure_radar:      foreclosureRadar,
  school_district_report: schoolDistrictReport,
  mortgage_calculator:    mortgageCalculator,
  rental_comps:           rentalComps,
  tax_assessment_lookup:  taxAssessmentLookup,
  similar_homes:          similarHomes,
  send_client_alert:      sendClientAlert,
};

// ── Server init ──────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'nj-realtor-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_HANDLERS[name];

  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    logger.info(`Tool called: ${name}`, { args });
    const result = await handler(args);
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    logger.error(`Tool error: ${name}`, { error: err.message });
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
async function main() {
  await db.connect();
  await cache.connect();
  logger.info('NJ Realtor MCP server starting...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server ready — 20 tools registered');
}

main().catch((err) => { logger.error('Fatal', err); process.exit(1); });
