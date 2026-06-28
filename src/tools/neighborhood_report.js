/**
 * neighborhood_report tool
 * 
 * Aggregates from: GreatSchools, NJ DOE, SpotCrime, Walk Score,
 * Census ACS, NJ DEP, FEMA, NJ Transit GTFS, and MLS market data.
 */

import { geocodeAddress }    from '../utils/geocode.js';
import { censusClient }      from '../data/census_client.js';
import { callClaude }        from '../utils/claude.js';
import { crawlFloodRisk, crawlCrimeData } from '../crawlers/crawl4ai.js';
import { cache }             from '../data/cache.js';
import axios                 from 'axios';
import { logger }            from '../utils/logger.js';

const CACHE_TTL = 60 * 60 * 24; // 24 hours — neighborhood data is slow-moving

export async function neighborhoodReport({ address_or_zip, sections = ['all'] }) {
  const cacheKey = `nbr:${address_or_zip}:${sections.sort().join(',')}`;
  const cached = await cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  logger.info('Building neighborhood report', { address_or_zip });

  const doAll   = sections.includes('all');
  const include = (s) => doAll || sections.includes(s);

  const geo = await geocodeAddress(address_or_zip);
  if (!geo) throw new Error(`Could not geocode: ${address_or_zip}`);

  const results = {};

  // Fan out all requested sections in parallel
  await Promise.all([
    include('schools')       && fetchSchools(geo, results),
    include('crime')         && fetchCrime(geo, results),
    include('walkability')   && fetchWalkability(geo, results),
    include('flood')         && fetchFlood(address_or_zip, results),
    include('demographics')  && fetchDemographics(geo, results),
    include('market')        && fetchMarketStats(geo, results),
    include('amenities')     && fetchAmenities(geo, results),
  ]);

  // AI synthesis narrative
  results.summary = await callClaude(`
You are a top NJ real estate agent briefing a buyer client about a neighborhood.
Data: ${JSON.stringify(results, null, 2)}

Write a 3-paragraph neighborhood brief that covers:
1. The overall character and vibe (family-friendly? urban? suburban?)
2. Key strengths (use specific numbers from the data)
3. Key concerns or watch-outs (be honest)

Be warm but factual. Mention NJ Transit access if relevant. Mention school district prominently.
Avoid generic phrases like "great community". Use actual data points.
`);

  results.generated_at  = new Date().toISOString();
  results.location      = geo;

  await cache.setex(cacheKey, CACHE_TTL, JSON.stringify(results));
  return results;
}

// ── Section fetchers ─────────────────────────────────────────────────────────

async function fetchSchools(geo, results) {
  try {
    const [gsData, njDoeData] = await Promise.all([
      fetchGreatSchools(geo),
      fetchNJDOEData(geo),
    ]);

    results.schools = {
      elementary: gsData.filter(s => s.level === 'elementary'),
      middle:     gsData.filter(s => s.level === 'middle'),
      high:       gsData.filter(s => s.level === 'high'),
      district_summary: njDoeData,
      source: 'GreatSchools API + NJ DOE Report Card',
    };
  } catch (err) {
    logger.warn('Schools fetch failed', { err: err.message });
    results.schools = { error: err.message };
  }
}

async function fetchGreatSchools(geo) {
  const resp = await axios.get(`${process.env.GREATSCHOOLS_URL}/schools/nearby`, {
    params: { lat: geo.lat, lon: geo.lng, limit: 10, radius: 3 },
    headers: { 'x-api-key': process.env.GREATSCHOOLS_API_KEY },
  });

  return (resp.data?.schools || []).map(s => ({
    name:    s.name,
    level:   s.levelCode,
    rating:  s.rating,         // 1-10
    type:    s.type,           // public / private / charter
    grades:  s.gradeLevels,
    students: s.enrollment,
    distance_miles: s.distance,
  }));
}

async function fetchNJDOEData(geo) {
  // NJ DOE publishes school report cards — we crawl the district data
  // NJ's District Factor Group (DFG) is critical: A (poorest) to J (wealthiest)
  // This is a strong proxy for school quality and property values
  try {
    const resp = await axios.get(`${process.env.NJ_OPENDATA_URL}/t7pd-g8kp.json`, {
      params: {
        '$where': `within_circle(location, ${geo.lat}, ${geo.lng}, 5000)`,
        '$limit': 5,
      },
    });

    return resp.data?.map(d => ({
      district:       d.district_name,
      dfg:            d.district_factor_group, // A, B, CD, DE, FG, GH, I, J
      county:         d.county_name,
      enrollment:     d.total_enrollment,
      grad_rate:      d.graduation_rate_4yr,
      proficiency_ela: d.ela_proficiency,
      proficiency_math: d.math_proficiency,
    })) || [];
  } catch {
    return [];
  }
}

async function fetchCrime(geo, results) {
  try {
    const crimeData = await crawlCrimeData(geo.lat, geo.lng, 0.5);
    const crimes    = crimeData?.extracted?.crimes || [];

    const byCat = crimes.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] || 0) + 1;
      return acc;
    }, {});

    results.crime = {
      total_incidents_6mo: crimes.length,
      by_type: byCat,
      index: scoreCrime(crimes.length),
      source: 'SpotCrime (0.5mi radius, last 6 months)',
    };
  } catch (err) {
    logger.warn('Crime fetch failed', { err: err.message });
    results.crime = { error: err.message };
  }
}

async function fetchWalkability(geo, results) {
  try {
    const resp = await axios.get(process.env.WALKSCORE_URL, {
      params: {
        wsapikey: process.env.WALKSCORE_API_KEY,
        address:  geo.formatted_address,
        lat:      geo.lat,
        lon:      geo.lng,
        format:   'json',
        transit:  1,
        bike:     1,
      },
    });

    results.walkability = {
      walk_score:    resp.data.walkscore,
      walk_desc:     resp.data.description,
      transit_score: resp.data.transit?.score,
      transit_desc:  resp.data.transit?.description,
      bike_score:    resp.data.bike?.score,
      bike_desc:     resp.data.bike?.description,
      source: 'Walk Score API',
    };
  } catch (err) {
    results.walkability = { error: err.message };
  }
}

async function fetchFlood(address, results) {
  try {
    const floodData = await crawlFloodRisk(address);
    results.flood = {
      ...floodData.extracted,
      risk_level: classifyFloodRisk(floodData.extracted?.fema_flood_zone),
      note: 'NJ coastal properties: verify NFIP insurance availability and cost before purchase.',
      source: 'NJ Flood Mapper + FEMA NFIP',
    };
  } catch (err) {
    results.flood = { error: err.message };
  }
}

async function fetchDemographics(geo, results) {
  try {
    const data = await censusClient.getBlockGroupData(geo.lat, geo.lng);
    results.demographics = {
      median_household_income: data.B19013_001E,
      median_age:              data.B01002_001E,
      total_population:        data.B01003_001E,
      owner_occupied_pct:      calcOwnerOccupied(data),
      college_educated_pct:    calcCollegeEd(data),
      diversity_index:         calcDiversityIndex(data),
      source: 'US Census ACS 5-Year Estimates',
      year: '2023',
    };
  } catch (err) {
    results.demographics = { error: err.message };
  }
}

async function fetchMarketStats(geo, results) {
  try {
    // Pull from our local MLS cache
    const { mlsClient } = await import('../data/mls_client.js');
    const stats = await mlsClient.getLocalMarketStats({ lat: geo.lat, lng: geo.lng, radius: 1 });
    results.market = {
      median_list_price:    stats.median_list,
      median_sold_price:    stats.median_sold,
      avg_dom:              stats.avg_dom,
      list_to_sold_ratio:   stats.l2s_ratio,
      active_listings:      stats.active_count,
      sold_last_90:         stats.sold_90d,
      price_change_yoy:     stats.yoy_change,
      source: 'MLS + Redfin',
    };
  } catch (err) {
    results.market = { error: err.message };
  }
}

async function fetchAmenities(geo, results) {
  try {
    // Google Places nearby search for key amenity categories
    const categories = ['grocery_or_supermarket', 'restaurant', 'hospital', 'park', 'gym'];
    const amenities  = {};

    await Promise.all(categories.map(async (cat) => {
      const resp = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: { location: `${geo.lat},${geo.lng}`, radius: 1600, type: cat, key: process.env.GOOGLE_MAPS_API_KEY },
      });
      amenities[cat] = (resp.data.results || []).slice(0, 3).map(p => ({
        name: p.name, rating: p.rating, distance_approx: '~1mi',
      }));
    }));

    results.amenities = { ...amenities, source: 'Google Places API (1-mile radius)' };
  } catch (err) {
    results.amenities = { error: err.message };
  }
}

// ── Scoring helpers ──────────────────────────────────────────────────────────

function scoreCrime(incidentCount) {
  if (incidentCount < 5)  return { score: 'A', label: 'Very Low' };
  if (incidentCount < 15) return { score: 'B', label: 'Low' };
  if (incidentCount < 30) return { score: 'C', label: 'Moderate' };
  if (incidentCount < 60) return { score: 'D', label: 'High' };
  return { score: 'F', label: 'Very High' };
}

function classifyFloodRisk(zone = '') {
  if (['A', 'AE', 'AH', 'AO', 'AR', 'A99', 'V', 'VE'].includes(zone.toUpperCase())) return 'HIGH';
  if (['B', 'X (shaded)'].includes(zone)) return 'MODERATE';
  return 'LOW';
}

function calcOwnerOccupied(data) {
  if (!data.B25003_001E || data.B25003_001E === 0) return null;
  return parseFloat(((data.B25003_002E / data.B25003_001E) * 100).toFixed(1));
}

function calcCollegeEd(data) {
  const total = data.B15003_001E;
  if (!total) return null;
  const college = (data.B15003_022E || 0) + (data.B15003_023E || 0) + (data.B15003_024E || 0) + (data.B15003_025E || 0);
  return parseFloat(((college / total) * 100).toFixed(1));
}

function calcDiversityIndex(data) {
  // Shannon diversity index on race data
  const total = data.B02001_001E;
  if (!total) return null;
  const groups = [data.B02001_002E, data.B02001_003E, data.B02001_004E, data.B02001_005E, data.B02001_006E];
  const shannon = -groups.reduce((sum, g) => {
    const p = g / total;
    return p > 0 ? sum + p * Math.log(p) : sum;
  }, 0);
  return parseFloat((shannon / Math.log(groups.length) * 100).toFixed(1));
}
