/**
 * Background cron jobs
 * 
 * Schedule:
 *   Every 5 min   — Check client alert triggers (new listings matching saved searches)
 *   Every 15 min  — Sync MLS active listings (GSMLS + Bright)
 *   Every 1 hour  — Process crawl job queue (Zillow, tax portals, etc.)
 *   Every 6 hours — Refresh rental comp cache
 *   Nightly 2am   — Aggregate market stats by ZIP / municipality / county
 *   Nightly 3am   — Generate embeddings for new properties (OpenAI)
 *   Weekly Sunday — Full Redfin data refresh, mortgage rate update (FRED)
 */

import 'dotenv/config';
import cron from 'node-cron';
import { db }    from './data/db.js';
import { cache } from './data/cache.js';
import { logger } from './utils/logger.js';
import { mlsClient }   from './data/mls_client.js';
import { fredClient }  from './data/fred_client.js';
import { generateEmbedding } from './utils/embeddings.js';
import { sendClientAlert }   from './tools/send_client_alert.js';
import { marketPulse }       from './tools/market_pulse.js';

// Track running jobs to avoid overlaps
const running = new Set();

async function runJob(name, fn) {
  if (running.has(name)) {
    logger.warn(`Job ${name} already running, skipping`);
    return;
  }
  running.add(name);
  const start = Date.now();
  try {
    logger.info(`Job START: ${name}`);
    await fn();
    logger.info(`Job DONE: ${name}`, { ms: Date.now() - start });
  } catch (err) {
    logger.error(`Job ERROR: ${name}`, { error: err.message });
  } finally {
    running.delete(name);
  }
}

// ── MLS Sync (every 15 min) ───────────────────────────────────────────────────
cron.schedule('*/15 * * * *', () => runJob('mls_sync', async () => {
  const since = new Date(Date.now() - 16 * 60 * 1000); // last 16 min (with overlap)

  const [gsmlsListings, brightListings] = await Promise.all([
    mlsClient.getModifiedSince('gsmls', since),
    mlsClient.getModifiedSince('bright', since),
  ]);

  const allListings = [...gsmlsListings, ...brightListings];
  logger.info(`MLS sync: ${allListings.length} listings`);

  for (const listing of allListings) {
    await db.query(`
      INSERT INTO properties (mls_id, address, city, county, zip, municipality,
        lat, lng, location, property_type, beds, baths, sqft, lot_sqft, year_built,
        garage, pool, basement, status, list_price, sold_price, list_date, sold_date,
        days_on_market, annual_tax, school_district, description, features, photos,
        source, raw_data, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
        ST_SetSRID(ST_MakePoint($9, $8), 4326),
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28, $29, $30, $31, NOW())
      ON CONFLICT (mls_id) DO UPDATE SET
        status = EXCLUDED.status,
        list_price = EXCLUDED.list_price,
        sold_price = EXCLUDED.sold_price,
        days_on_market = EXCLUDED.days_on_market,
        updated_at = NOW(),
        raw_data = EXCLUDED.raw_data
    `, [
      listing.mls_id, listing.address, listing.city, listing.county,
      listing.zip, listing.municipality, listing.lat, listing.lng, listing.lng,
      listing.property_type, listing.beds, listing.baths, listing.sqft,
      listing.lot_sqft, listing.year_built, listing.garage, listing.pool,
      listing.basement, listing.status, listing.list_price, listing.sold_price,
      listing.list_date, listing.sold_date, listing.days_on_market,
      listing.annual_tax, listing.school_district, listing.description,
      listing.features, listing.photos, listing.source, JSON.stringify(listing),
    ]);
  }

  // Invalidate market stat caches for affected ZIPs
  const affectedZips = [...new Set(allListings.map(l => l.zip).filter(Boolean))];
  await Promise.all(affectedZips.map(zip => cache.del(`market:${zip}`)));
}));

// ── Client Alert Check (every 5 min) ─────────────────────────────────────────
cron.schedule('*/5 * * * *', () => runJob('client_alerts', async () => {
  // Find new listings (added in last 5 min)
  const newListings = await db.query(`
    SELECT * FROM properties 
    WHERE status = 'active' 
    AND created_at > NOW() - INTERVAL '6 minutes'
    ORDER BY created_at DESC
  `);

  if (!newListings.rows.length) return;

  // Load all active buyer profiles
  const clients = await db.query(`
    SELECT * FROM clients 
    WHERE type IN ('buyer', 'investor') 
    AND alert_enabled = true
  `);

  let alertCount = 0;

  for (const client of clients.rows) {
    const criteria = client.criteria || {};

    for (const listing of newListings.rows) {
      if (matchesCriteria(listing, criteria)) {
        await sendClientAlert({
          client_phone_or_email: client.phone || client.email,
          listing_address: listing.address,
          personal_note: `New listing just hit the market matching your search!`,
          channels: client.alert_channels || ['sms'],
        });
        alertCount++;
      }
    }
  }

  if (alertCount > 0) {
    logger.info(`Client alerts sent: ${alertCount}`);
  }
}));

// ── Crawl Queue Processor (every 1 hour) ─────────────────────────────────────
cron.schedule('0 * * * *', () => runJob('crawl_queue', async () => {
  const { crawlAndExtract } = await import('./crawlers/crawl4ai.js');

  const jobs = await db.query(`
    SELECT * FROM crawl_jobs 
    WHERE status = 'pending' 
    AND attempts < max_attempts
    AND scheduled_at <= NOW()
    ORDER BY priority DESC, scheduled_at
    LIMIT 50
  `);

  logger.info(`Processing ${jobs.rows.length} crawl jobs`);

  for (const job of jobs.rows) {
    try {
      await db.query(`UPDATE crawl_jobs SET status='running', started_at=NOW(), attempts=attempts+1 WHERE id=$1`, [job.id]);
      const result = await crawlAndExtract(job.url, job.payload?.schema, job.payload?.options);
      await db.query(`UPDATE crawl_jobs SET status='done', result=$1, completed_at=NOW() WHERE id=$2`, [JSON.stringify(result), job.id]);
    } catch (err) {
      const status = job.attempts + 1 >= job.max_attempts ? 'failed' : 'pending';
      await db.query(`UPDATE crawl_jobs SET status=$1, error=$2 WHERE id=$3`, [status, err.message, job.id]);
    }
  }
}));

// ── Embedding Generation (nightly 3am) ───────────────────────────────────────
cron.schedule('0 3 * * *', () => runJob('embeddings', async () => {
  // Generate embeddings for properties missing them
  const rows = await db.query(`
    SELECT id, address, description, beds, baths, sqft, city, school_district, features
    FROM properties 
    WHERE embedding IS NULL 
    AND description IS NOT NULL
    LIMIT 500
  `);

  logger.info(`Generating embeddings for ${rows.rows.length} properties`);

  for (const prop of rows.rows) {
    const text = buildEmbeddingText(prop);
    const embedding = await generateEmbedding(text);
    await db.query(`UPDATE properties SET embedding = $1 WHERE id = $2`, [
      JSON.stringify(embedding), prop.id
    ]);
    // Rate limit: OpenAI allows 3000 RPM on text-embedding-3-large
    await sleep(20);
  }
}));

// ── Market Stats Aggregation (nightly 2am) ───────────────────────────────────
cron.schedule('0 2 * * *', () => runJob('market_stats', async () => {
  // Aggregate sold data by ZIP and municipality
  const areas = await db.query(`
    SELECT DISTINCT zip FROM properties WHERE zip IS NOT NULL
  `);

  for (const { zip } of areas.rows) {
    await aggregateMarketStats('zip', zip);
  }

  const munis = await db.query(`
    SELECT DISTINCT municipality FROM properties WHERE municipality IS NOT NULL
  `);

  for (const { municipality } of munis.rows) {
    await aggregateMarketStats('municipality', municipality);
  }

  logger.info('Market stats aggregation complete');
}));

// ── Mortgage Rate Update (weekly Monday 6am) ──────────────────────────────────
cron.schedule('0 6 * * 1', () => runJob('mortgage_rates', async () => {
  const rate30yr  = await fredClient.getCurrentMortgageRate('30yr');
  const rate15yr  = await fredClient.getCurrentMortgageRate('15yr');
  const rate5_1arm = await fredClient.getCurrentMortgageRate('5_1arm');

  await cache.set('mortgage:30yr',   rate30yr.toString(),  'EX', 7 * 24 * 3600);
  await cache.set('mortgage:15yr',   rate15yr.toString(),  'EX', 7 * 24 * 3600);
  await cache.set('mortgage:5_1arm', rate5_1arm.toString(),'EX', 7 * 24 * 3600);

  logger.info('Mortgage rates updated', { rate30yr, rate15yr, rate5_1arm });
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchesCriteria(listing, criteria) {
  if (criteria.min_price && listing.list_price < criteria.min_price) return false;
  if (criteria.max_price && listing.list_price > criteria.max_price) return false;
  if (criteria.min_beds  && listing.beds < criteria.min_beds)        return false;
  if (criteria.min_baths && listing.baths < criteria.min_baths)      return false;
  if (criteria.zip_codes?.length && !criteria.zip_codes.includes(listing.zip)) return false;
  if (criteria.property_type && listing.property_type !== criteria.property_type) return false;
  return true;
}

function buildEmbeddingText(prop) {
  return [
    `${prop.beds}BR ${prop.baths}BA ${prop.sqft ? prop.sqft + 'sqft' : ''} in ${prop.city}`,
    `School district: ${prop.school_district || 'N/A'}`,
    prop.features?.join(', '),
    prop.description,
  ].filter(Boolean).join(' ').slice(0, 8000);
}

async function aggregateMarketStats(areaType, areaCode) {
  const result = await db.query(`
    SELECT 
      COUNT(*) FILTER (WHERE status = 'active') AS active_count,
      COUNT(*) FILTER (WHERE status = 'sold' AND sold_date >= NOW() - INTERVAL '90 days') AS sold_count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY list_price) FILTER (WHERE status = 'active') AS median_list,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sold_price) FILTER (WHERE status = 'sold' AND sold_date >= NOW() - INTERVAL '90 days') AS median_sold,
      AVG(days_on_market) FILTER (WHERE status = 'sold' AND sold_date >= NOW() - INTERVAL '90 days') AS avg_dom,
      AVG(CASE WHEN list_price > 0 THEN sold_price::float / list_price END) 
        FILTER (WHERE status = 'sold' AND sold_date >= NOW() - INTERVAL '90 days') AS list_to_sold
    FROM properties
    WHERE ${areaType === 'zip' ? 'zip' : 'municipality'} = $1
  `, [areaCode]);

  const stats = result.rows[0];

  await db.query(`
    INSERT INTO market_stats (area_type, area_code, period_start, period_end,
      active_count, sold_count, median_list, median_sold, avg_dom, list_to_sold, source)
    VALUES ($1, $2, NOW() - INTERVAL '90 days', NOW(), $3, $4, $5, $6, $7, $8, 'mls_aggregated')
    ON CONFLICT (area_type, area_code, property_type, period_start) DO UPDATE SET
      active_count = EXCLUDED.active_count,
      sold_count   = EXCLUDED.sold_count,
      median_list  = EXCLUDED.median_list,
      median_sold  = EXCLUDED.median_sold,
      avg_dom      = EXCLUDED.avg_dom,
      list_to_sold = EXCLUDED.list_to_sold,
      computed_at  = NOW()
  `, [areaType, areaCode, stats.active_count, stats.sold_count,
      stats.median_list, stats.median_sold, stats.avg_dom, stats.list_to_sold]);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Start ────────────────────────────────────────────────────────────────────
async function main() {
  await db.connect();
  await cache.connect();
  logger.info('Cron service started — all jobs scheduled');
  logger.info('Jobs: mls_sync(15m), client_alerts(5m), crawl_queue(1h), embeddings(3am), market_stats(2am), mortgage_rates(weekly)');
}

main().catch(err => { logger.error('Cron fatal', err); process.exit(1); });
