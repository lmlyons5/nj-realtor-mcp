/**
 * Crawl4AI integration — async real estate web crawler
 * 
 * Crawl4AI runs as a separate Docker container with a Playwright backend.
 * This module sends crawl jobs and processes structured extraction results.
 * 
 * Key crawl targets for NJ:
 *   - Zillow NJ property pages (listing details, price history, Zestimate)
 *   - Realtor.com NJ listings
 *   - Redfin NJ data (their CSV export is a goldmine)
 *   - NJ county tax/assessment portals (565 municipalities)
 *   - NJCourts lis pendens and judgment search
 *   - NJ Flood Mapper
 *   - Municipal permit portals
 *   - Apartments.com / Zillow rentals for rental comps
 *   - SpotCrime for crime data
 *   - GreatSchools NJ pages
 */

import axios from 'axios';
import axiosRetry from 'axios-retry';
import pLimit from 'p-limit';
import { logger } from '../utils/logger.js';

const crawl4ai = axios.create({
  baseURL: process.env.CRAWL4AI_URL || 'http://localhost:11235',
  timeout: 60_000,
  headers: {
    'Authorization': `Bearer ${process.env.CRAWL4AI_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

axiosRetry(crawl4ai, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// Limit concurrency so we don't hammer sites
const limiter = pLimit(3);

// ── Core crawl function ──────────────────────────────────────────────────────

/**
 * Crawl a URL and extract structured data using Crawl4AI's LLM extraction.
 * 
 * @param {string} url - Target URL
 * @param {object} extractionSchema - JSON schema for structured extraction
 * @param {object} options - Crawl options
 */
export async function crawlAndExtract(url, extractionSchema, options = {}) {
  return limiter(async () => {
    logger.info(`Crawling: ${url}`);

    const payload = {
      urls: [url],
      browser_config: {
        headless: true,
        use_persistent_context: false,
        // Rotate user agents to avoid blocks
        user_agent: options.userAgent || getRandomUserAgent(),
      },
      crawler_config: {
        wait_for: options.waitFor || 'networkidle',
        delay_before_return_html: options.delay || 1000,
        screenshot: false,
        // Anti-bot: random human-like delays
        simulate_user: true,
        magic: true, // Crawl4AI's anti-detection mode
      },
      extraction_config: {
        type: 'llm',
        provider: 'anthropic/claude-sonnet-4-6',
        schema: extractionSchema,
        instruction: options.instruction || 'Extract all real estate data from this page as structured JSON.',
      },
    };

    const response = await crawl4ai.post('/crawl', payload);
    const result = response.data?.results?.[0];

    if (!result?.success) {
      throw new Error(`Crawl failed for ${url}: ${result?.error_message}`);
    }

    return {
      url,
      extracted: result.extracted_content ? JSON.parse(result.extracted_content) : null,
      markdown: result.markdown,
      crawledAt: new Date().toISOString(),
    };
  });
}

// ── Site-specific crawlers ───────────────────────────────────────────────────

/** Zillow property detail page */
export async function crawlZillowProperty(address) {
  const searchUrl = `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`;

  const schema = {
    type: 'object',
    properties: {
      zpid:            { type: 'string' },
      address:         { type: 'string' },
      price:           { type: 'number' },
      zestimate:       { type: 'number' },
      zestimate_range: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } } },
      beds:            { type: 'integer' },
      baths:           { type: 'number' },
      sqft:            { type: 'integer' },
      lot_sqft:        { type: 'integer' },
      year_built:      { type: 'integer' },
      days_on_zillow:  { type: 'integer' },
      price_history:   { type: 'array', items: {
        type: 'object',
        properties: { date: { type: 'string' }, price: { type: 'number' }, event: { type: 'string' } }
      }},
      tax_history:     { type: 'array', items: {
        type: 'object',
        properties: { year: { type: 'integer' }, tax_paid: { type: 'number' }, assessment: { type: 'number' } }
      }},
      hoa_fee:         { type: 'number' },
      parking:         { type: 'string' },
      heating:         { type: 'string' },
      cooling:         { type: 'string' },
      description:     { type: 'string' },
      photos:          { type: 'array', items: { type: 'string' } },
      listing_agent:   { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' } } },
    },
  };

  return crawlAndExtract(searchUrl, schema, {
    waitFor: 'css:[data-testid="bed-bath-item"]',
    instruction: 'Extract complete property listing details, all price history events, and tax history from this Zillow property page.',
  });
}

/** NJ County Tax Assessment portals — we map each county to its portal URL */
const NJ_COUNTY_TAX_PORTALS = {
  monmouth:   'https://www.monmouthcountyclerk.com/land-records',
  ocean:      'https://www.oceancountyclerk.com/192/Land-Records',
  bergen:     'https://www.bergencountyclerk.org/land-records/',
  essex:      'https://clerk.essexcountynj.org/land-records/',
  morris:     'https://morriscountyclerk.org/land-records/',
  middlesex:  'https://co.middlesex.nj.us/CountyClerk/LandRecords/index.asp',
  union:      'https://www.ucnj.org/county-clerk/',
  hudson:     'https://hcnj.us/county-clerk/',
  somerset:   'https://www.somersetcountyclerk.org/services/landrecords/',
  passaic:    'https://www.passaiccountyclerk.com/land-records/',
  // Also use NJ MOD-IV (Master Odometer Data) — statewide tax assessment
  statewide:  'https://www.njactb.org/OnlineSales',
};

/** NJ Flood Mapper for flood zone data */
export async function crawlFloodRisk(address) {
  const url = `https://njfloodmapper.org/?address=${encodeURIComponent(address)}`;

  const schema = {
    type: 'object',
    properties: {
      fema_flood_zone:        { type: 'string', description: 'e.g. AE, X, VE' },
      base_flood_elevation:   { type: 'number' },
      community_panel_number: { type: 'string' },
      effective_date:         { type: 'string' },
      in_special_flood_hazard_area: { type: 'boolean' },
      nj_dep_flood_hazard:    { type: 'boolean' },
    },
  };

  return crawlAndExtract(url, schema, {
    delay: 2000,
    instruction: 'Extract FEMA flood zone designation, base flood elevation, and NJ DEP flood hazard information.',
  });
}

/** SpotCrime for neighborhood crime data */
export async function crawlCrimeData(lat, lng, radius = 0.5) {
  const url = `https://spotcrime.com/crimes.json?lat=${lat}&lon=${lng}&radius=${radius}&callback=spotcrime`;

  // SpotCrime has a JSON endpoint, prefer direct API if key available
  const schema = {
    type: 'object',
    properties: {
      crimes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type:    { type: 'string' },
            date:    { type: 'string' },
            address: { type: 'string' },
          },
        },
      },
      total_count: { type: 'integer' },
    },
  };

  return crawlAndExtract(url, schema, {
    instruction: 'Extract all crime incidents including type, date, and location.',
  });
}

/** Redfin data download (they provide CSV exports) */
export async function fetchRedfinMarketData(regionId, regionType = 'zip') {
  // Redfin's undocumented but stable CSV endpoint
  const url = `https://www.redfin.com/stingray/api/gis-csv?al=1&market=new-jersey&region_id=${regionId}&region_type=${regionType}&mrtf=0&sold_within_days=365&uipt=1,2,3,4&num_homes=999`;

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': getRandomUserAgent() },
      responseType: 'text',
    });
    return parseRedfinCSV(response.data);
  } catch (err) {
    logger.warn('Redfin CSV fetch failed, falling back to crawler', { err: err.message });
    return crawlAndExtract(`https://www.redfin.com/zipcode/${regionId}/housing-market`, {
      type: 'object',
      properties: {
        median_sale_price: { type: 'number' },
        median_days_on_market: { type: 'integer' },
        months_of_supply: { type: 'number' },
        sold_above_list_pct: { type: 'number' },
      },
    });
  }
}

function parseRedfinCSV(csvText) {
  // Parse CSV manually for lightweight processing
  const lines = csvText.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/ /g, '_'));
  return lines.slice(1).filter(Boolean).map(line => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]?.trim()]));
  });
}

/** NJ Transit schedule lookup */
export async function crawlNJTransitSchedule(fromStation, toStation, departTime) {
  const url = `https://www.njtransit.com/rp/rp.srv?action=doDepartureFinderTrain&fromStation=${encodeURIComponent(fromStation)}&toStation=${encodeURIComponent(toStation)}&StartDate=${getTodayStr()}&StartTime=${encodeURIComponent(departTime)}&fld=D`;

  const schema = {
    type: 'object',
    properties: {
      trips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            depart: { type: 'string' },
            arrive: { type: 'string' },
            duration_mins: { type: 'integer' },
            line: { type: 'string' },
            transfers: { type: 'integer' },
          },
        },
      },
    },
  };

  return crawlAndExtract(url, schema, {
    delay: 2000,
    instruction: 'Extract all train departure times, arrival times, total travel duration, and transfer count.',
  });
}

/** Apartments.com rental listings for rental comp analysis */
export async function crawlApartmentsDotCom(zip, bedrooms) {
  const bedroomPath = bedrooms === 0 ? 'studio-apartments' : `${bedrooms}-bedroom-apartments`;
  const url = `https://www.apartments.com/${bedroomPath}/${zip}/`;

  const schema = {
    type: 'object',
    properties: {
      listings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:         { type: 'string' },
            address:      { type: 'string' },
            min_rent:     { type: 'number' },
            max_rent:     { type: 'number' },
            beds:         { type: 'integer' },
            baths:        { type: 'number' },
            sqft:         { type: 'integer' },
            available:    { type: 'boolean' },
            amenities:    { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };

  return crawlAndExtract(url, schema, {
    waitFor: 'css:.placardHeader',
    instruction: 'Extract all rental listings with price, size, and amenity details.',
  });
}

// ── Utility ──────────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getTodayStr() {
  return new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

export { NJ_COUNTY_TAX_PORTALS };
