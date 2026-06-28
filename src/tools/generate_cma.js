/**
 * generate_cma tool
 * 
 * Pulls sold comps from MLS + ATTOM, applies hedonic price adjustments,
 * runs a weighted regression, and produces a valuation range.
 * 
 * Adjustment grid (standard NJ residential):
 *   - Bedroom:      +/- $12,000 per bedroom (market-adjusted)
 *   - Bathroom:     +/- $8,000 per full bath
 *   - GLA (sqft):   +/- $X per sqft (derived from local comps)
 *   - Lot size:     +/- $Y per sqft (higher in suburbs, lower in urban)
 *   - Age:          +/- $2,000 per year vs subject (diminishing returns)
 *   - Condition:    0% / +5% / +10% / -5% / -15%
 *   - Garage:       +$18,000 (NJ average)
 *   - Pool:         +$15,000 (NJ average; less near shore)
 *   - Basement:     +$25,000 finished / +$8,000 unfinished
 */

import { mlsClient }        from '../data/mls_client.js';
import { attomClient }      from '../data/attom_client.js';
import { geocodeAddress }   from '../utils/geocode.js';
import { generatePDFReport } from '../utils/pdf_report.js';
import { callClaude }       from '../utils/claude.js';
import { cache }            from '../data/cache.js';
import { logger }           from '../utils/logger.js';

const CACHE_TTL = 60 * 60 * 6; // 6 hours

export async function generateCMA({
  address,
  radius_miles = 0.5,
  months_back = 6,
  include_active = true,
  output_format = 'markdown',
}) {
  const cacheKey = `cma:${address}:${radius_miles}:${months_back}`;
  const cached = await cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  logger.info('Generating CMA', { address });

  // 1. Geocode subject property
  const subject = await geocodeAddress(address);
  if (!subject) throw new Error(`Could not geocode address: ${address}`);

  // 2. Get subject property details from MLS + ATTOM
  const [mlsSubject, attomSubject] = await Promise.all([
    mlsClient.getPropertyByAddress(address).catch(() => null),
    attomClient.getPropertyDetail(address).catch(() => null),
  ]);

  const subjectDetails = mergePropertyData(mlsSubject, attomSubject);

  // 3. Fetch comparable sales
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - months_back);

  const [mlsComps, attomComps] = await Promise.all([
    mlsClient.getSoldComps({
      lat: subject.lat,
      lng: subject.lng,
      radius_miles,
      since: sinceDate.toISOString(),
      property_type: subjectDetails.property_type || 'residential',
      min_beds: Math.max(1, (subjectDetails.beds || 3) - 1),
      max_beds: (subjectDetails.beds || 3) + 1,
    }),
    attomClient.getSales({
      lat: subject.lat,
      lng: subject.lng,
      radius_miles: radius_miles + 0.25, // slightly wider for ATTOM
      since: sinceDate.toISOString(),
    }),
  ]);

  // 4. Deduplicate and merge comps (MLS takes priority)
  const comps = deduplicateComps(mlsComps, attomComps).slice(0, 15);

  if (comps.length < 3) {
    // Widen search if too few comps
    return generateCMA({ address, radius_miles: radius_miles * 2, months_back: months_back + 3, output_format });
  }

  // 5. Apply adjustments
  const adjustedComps = comps.map(comp => adjustComp(comp, subjectDetails));

  // 6. Calculate adjusted values
  const adjustedValues = adjustedComps.map(c => c.adjusted_sale_price).filter(Boolean);
  const median = calcMedian(adjustedValues);
  const mean   = adjustedValues.reduce((a, b) => a + b, 0) / adjustedValues.length;

  // Weight recent sales more heavily
  const weightedValue = calcWeightedValue(adjustedComps);

  // 7. Confidence interval (±1 std dev)
  const stdDev = calcStdDev(adjustedValues);
  const low    = Math.round((weightedValue - stdDev) / 1000) * 1000;
  const high   = Math.round((weightedValue + stdDev) / 1000) * 1000;
  const point  = Math.round(weightedValue / 1000) * 1000;

  // 8. Market stats
  const avgDOM   = calcMean(comps.map(c => c.days_on_market).filter(Boolean));
  const l2sRatio = calcMean(comps.map(c => c.list_to_sold_ratio).filter(Boolean));

  // 9. Active listings (competition analysis)
  let activeListings = [];
  if (include_active) {
    activeListings = await mlsClient.getActiveListings({
      lat: subject.lat, lng: subject.lng, radius_miles,
    });
  }

  // 10. AI narrative
  const narrative = await callClaude(`
Write a 3-paragraph CMA narrative for a realtor presenting to their client.
Subject property: ${address}
Estimated value range: $${low.toLocaleString()} – $${high.toLocaleString()} (point estimate: $${point.toLocaleString()})
Comps used: ${comps.length} sold comparables
Average DOM: ${Math.round(avgDOM)} days
List-to-sold ratio: ${(l2sRatio * 100).toFixed(1)}%
Active competing listings: ${activeListings.length}

Be professional but direct. Note key value drivers and any concerns.
Do NOT say "in conclusion". End with a recommended list price range.
`);

  const result = {
    subject: { address, ...subjectDetails },
    valuation: { low, point, high, confidence: calcConfidence(adjustedValues, comps.length) },
    market_stats: {
      avg_dom: Math.round(avgDOM),
      list_to_sold_ratio: parseFloat((l2sRatio * 100).toFixed(1)),
      comps_count: comps.length,
      active_competing: activeListings.length,
    },
    comps: adjustedComps.slice(0, 10).map(c => ({
      address: c.address,
      sale_price: c.sale_price,
      sale_date: c.sale_date,
      beds: c.beds, baths: c.baths, sqft: c.sqft,
      price_per_sqft: c.price_per_sqft,
      dom: c.days_on_market,
      net_adjustment: c.net_adjustment,
      adjusted_price: c.adjusted_sale_price,
      distance_miles: c.distance_miles,
    })),
    narrative,
    generated_at: new Date().toISOString(),
  };

  if (output_format === 'pdf') {
    result.pdf_url = await generatePDFReport('cma', result);
  }

  await cache.setex(cacheKey, CACHE_TTL, JSON.stringify(result));
  return result;
}

// ── Adjustment logic ─────────────────────────────────────────────────────────

function adjustComp(comp, subject) {
  let adjustment = 0;
  const adjustments = {};

  // Bedroom adjustment
  const bedDiff = (subject.beds || 3) - (comp.beds || 3);
  adjustments.bedrooms = bedDiff * 12_000;
  adjustment += adjustments.bedrooms;

  // Bathroom adjustment
  const bathDiff = (subject.baths || 2) - (comp.baths || 2);
  adjustments.bathrooms = bathDiff * 8_000;
  adjustment += adjustments.bathrooms;

  // GLA (sqft) adjustment — $150/sqft baseline, adjusted for market
  const sqftDiff = (subject.sqft || comp.sqft) - (comp.sqft || subject.sqft);
  const pricePerSqft = comp.price_per_sqft || 150;
  adjustments.sqft = sqftDiff * pricePerSqft;
  adjustment += adjustments.sqft;

  // Lot size adjustment
  if (subject.lot_sqft && comp.lot_sqft) {
    const lotDiff = subject.lot_sqft - comp.lot_sqft;
    adjustments.lot = lotDiff * 2; // ~$2/sqft lot adjustment
    adjustment += adjustments.lot;
  }

  // Garage
  if ((subject.garage || false) !== (comp.garage || false)) {
    adjustments.garage = subject.garage ? 18_000 : -18_000;
    adjustment += adjustments.garage;
  }

  // Pool
  if ((subject.pool || false) !== (comp.pool || false)) {
    adjustments.pool = subject.pool ? 15_000 : -15_000;
    adjustment += adjustments.pool;
  }

  // Age adjustment
  if (subject.year_built && comp.year_built) {
    const ageDiff = comp.year_built - subject.year_built; // positive = comp is newer
    adjustments.age = ageDiff * -1_500; // newer = higher value for comp
    adjustment += adjustments.age;
  }

  return {
    ...comp,
    net_adjustment: Math.round(adjustment),
    adjustments,
    adjusted_sale_price: Math.round((comp.sale_price || 0) + adjustment),
  };
}

function calcWeightedValue(adjustedComps) {
  const now = Date.now();
  let weightedSum = 0;
  let totalWeight = 0;

  for (const comp of adjustedComps) {
    const saleDate  = new Date(comp.sale_date).getTime();
    const daysOld   = (now - saleDate) / (1000 * 60 * 60 * 24);
    const proximity = 1 / (comp.distance_miles || 0.1);
    const recency   = Math.exp(-daysOld / 90); // decay over 90 days

    const weight = proximity * recency;
    weightedSum += (comp.adjusted_sale_price || 0) * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : calcMean(adjustedComps.map(c => c.adjusted_sale_price));
}

function calcConfidence(values, compCount) {
  const cv = calcStdDev(values) / calcMean(values);
  if (compCount >= 10 && cv < 0.05) return 'high';
  if (compCount >= 5  && cv < 0.10) return 'medium';
  return 'low';
}

function deduplicateComps(mlsComps = [], attomComps = []) {
  const seen = new Set(mlsComps.map(c => normalizeAddress(c.address)));
  const unique = [...mlsComps];
  for (const comp of attomComps) {
    if (!seen.has(normalizeAddress(comp.address))) {
      unique.push(comp);
      seen.add(normalizeAddress(comp.address));
    }
  }
  return unique.sort((a, b) => new Date(b.sale_date) - new Date(a.sale_date));
}

function normalizeAddress(addr = '') {
  return addr.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mergePropertyData(mls, attom) {
  return {
    beds:          mls?.beds         || attom?.beds,
    baths:         mls?.baths        || attom?.baths,
    sqft:          mls?.sqft         || attom?.building_sqft,
    lot_sqft:      mls?.lot_sqft     || attom?.lot_sqft,
    year_built:    mls?.year_built   || attom?.year_built,
    garage:        mls?.garage       || attom?.garage,
    pool:          mls?.pool         || attom?.pool,
    property_type: mls?.property_type || 'residential',
  };
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function calcMedian(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcMean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function calcStdDev(arr) {
  const mean = calcMean(arr);
  const variance = calcMean(arr.map(x => Math.pow(x - mean, 2)));
  return Math.sqrt(variance);
}
