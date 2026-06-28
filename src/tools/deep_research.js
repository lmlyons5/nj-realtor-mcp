/**
 * deep_research tool
 * 
 * The crown jewel. Claude plans and executes a multi-step research workflow:
 * 1. Parse the research question → identify what data is needed
 * 2. Fan out to all relevant data sources in parallel
 * 3. Synthesize results into a structured, citation-backed report
 * 
 * Modes:
 *   quick      — 3-5 sources, ~10s, good for "what's this house worth roughly?"
 *   standard   — 8-12 sources, ~30s, full property due diligence
 *   exhaustive — 15-20 sources, ~90s, investor underwriting package
 */

import Anthropic from '@anthropic-ai/sdk';
import { searchListings }       from './search_listings.js';
import { generateCMA }          from './generate_cma.js';
import { neighborhoodReport }   from './neighborhood_report.js';
import { investmentAnalysis }   from './investment_analysis.js';
import { permitLienLookup }     from './permit_lien_lookup.js';
import { floodRiskReport }      from './flood_risk_report.js';
import { priceHistory }         from './price_history.js';
import { taxAssessmentLookup }  from './tax_assessment.js';
import { commuteAnalysis }      from './commute_analysis.js';
import { schoolDistrictReport } from './school_district_report.js';
import { marketPulse }          from './market_pulse.js';
import { rentalComps }          from './rental_comps.js';
import { fetchRedfinMarketData } from '../crawlers/crawl4ai.js';
import { logger }               from '../utils/logger.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Tools that the research orchestrator can invoke
const RESEARCH_TOOLS = [
  { name: 'run_cma',             fn: generateCMA,          desc: 'Run comparative market analysis for a property' },
  { name: 'get_neighborhood',    fn: neighborhoodReport,   desc: 'Get neighborhood intelligence' },
  { name: 'check_permits_liens', fn: permitLienLookup,     desc: 'Check permits, liens, lis pendens' },
  { name: 'get_flood_risk',      fn: floodRiskReport,      desc: 'Get FEMA flood zone and NJ DEP flood data' },
  { name: 'get_price_history',   fn: priceHistory,         desc: 'Get full sales and assessment history' },
  { name: 'get_tax_assessment',  fn: taxAssessmentLookup,  desc: 'Get NJ property tax assessment data' },
  { name: 'analyze_commute',     fn: commuteAnalysis,      desc: 'Analyze commute times to key destinations' },
  { name: 'get_schools',         fn: schoolDistrictReport, desc: 'Get school district ratings and data' },
  { name: 'get_market_pulse',    fn: marketPulse,          desc: 'Get local market snapshot' },
  { name: 'get_rental_comps',    fn: rentalComps,          desc: 'Get rental market comps and estimates' },
  { name: 'search_listings',     fn: searchListings,       desc: 'Search active MLS listings' },
  { name: 'analyze_investment',  fn: investmentAnalysis,   desc: 'Run investment underwriting' },
];

const DEPTH_CONFIG = {
  quick:      { maxTools: 4,  maxTokens: 1500 },
  standard:   { maxTools: 8,  maxTokens: 4000 },
  exhaustive: { maxTools: 15, maxTokens: 8000 },
};

export async function deepResearch({ topic, depth = 'standard', output_format = 'markdown' }) {
  const config = DEPTH_CONFIG[depth];
  logger.info('Deep research started', { topic, depth });

  const systemPrompt = `You are a frontier NJ real estate research analyst with access to MLS data,
public records, crawled listing data, and market intelligence tools.

When given a research topic, you:
1. Identify which data sources are most relevant
2. Call the appropriate tools (up to ${config.maxTools} tools)
3. Synthesize findings into a comprehensive, actionable report

Always cite the source of each data point. Flag any red flags prominently.
Focus on what matters most for an NJ realtor and their client.
New Jersey-specific context to keep in mind:
- NJ has the highest property taxes in the US (avg 2.3% effective rate)
- Shore/coastal properties have significant flood risk (Hurricane Sandy precedent)
- NJ Transit commute to NYC is a primary value driver for many buyers
- School districts are THE #1 driver of family home purchases in NJ
- 565 separate municipalities = huge variance in tax rates and services
- Bergen/Essex/Morris/Monmouth/Ocean are the highest-activity counties`;

  const toolDefs = RESEARCH_TOOLS.map(t => ({
    name: t.name,
    description: t.desc,
    input_schema: { type: 'object', properties: { args: { type: 'object' } } },
  }));

  const messages = [{ role: 'user', content: `Research topic: ${topic}\nDepth: ${depth}` }];
  const gatheredData = [];
  let iterations = 0;

  // Agentic loop — Claude calls tools until it has enough data
  while (iterations < config.maxTools) {
    iterations++;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: config.maxTokens,
      system: systemPrompt,
      tools: toolDefs,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      // Execute all tool calls in parallel
      await Promise.all(toolUseBlocks.map(async (block) => {
        const tool = RESEARCH_TOOLS.find(t => t.name === block.name);
        let result;

        if (!tool) {
          result = { error: `Unknown tool: ${block.name}` };
        } else {
          try {
            result = await tool.fn(block.input?.args || {});
            gatheredData.push({ tool: block.name, data: result });
          } catch (err) {
            result = { error: err.message };
            logger.warn(`Tool ${block.name} failed`, { err: err.message });
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }));

      messages.push({ role: 'user', content: toolResults });
    }
  }

  // Final synthesis pass
  const synthResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: config.maxTokens,
    system: `You are an expert NJ real estate analyst. Using the research data gathered,
write a comprehensive ${output_format === 'markdown' ? 'Markdown' : output_format} report.

Structure:
# [Topic] — Research Report
## Executive Summary (3-4 sentences, key finding first)
## Property Details (if applicable)
## Market Analysis
## Risk Factors (⚠️ flag each one clearly)
## Opportunities
## Recommendation
## Data Sources

Be direct. Realtors need actionable intelligence, not hedging.
Flag NJ-specific issues: flood risk, tax burden, school district impact on value.`,
    messages: [
      ...messages,
      {
        role: 'user',
        content: `Now synthesize all the gathered data into a final ${output_format} report for: "${topic}". 
Data gathered: ${JSON.stringify(gatheredData.length)} data points from ${gatheredData.map(d => d.tool).join(', ')}.`,
      },
    ],
  });

  const report = synthResponse.content[0]?.text || 'Research synthesis failed.';

  logger.info('Deep research complete', { topic, toolsUsed: iterations, chars: report.length });

  return {
    report,
    metadata: {
      topic,
      depth,
      tools_used: gatheredData.map(d => d.tool),
      generated_at: new Date().toISOString(),
      data_points: gatheredData.length,
    },
  };
}
