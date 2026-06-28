/**
 * investment_analysis tool
 * 
 * Full rental property underwriting for NJ.
 * NJ-specific considerations:
 *   - Property taxes: avg 2.23% effective rate (highest in US)
 *   - Landlord-tenant laws: very tenant-friendly (NJ Anti-Eviction Act)
 *   - Rent control: ~100 municipalities have rent control ordinances
 *   - Lead paint disclosure requirements (pre-1978 buildings)
 *   - Certificate of Occupancy required for every rental unit
 *   - Short-term rental restrictions vary by municipality
 */

import { attomClient }     from '../data/attom_client.js';
import { fredClient }      from '../data/fred_client.js';
import { rentalComps }     from './rental_comps.js';
import { taxAssessmentLookup } from './tax_assessment.js';
import { callClaude }      from '../utils/claude.js';
import { logger }          from '../utils/logger.js';

export async function investmentAnalysis({
  address,
  purchase_price,
  down_pct = 20,
  interest_rate,
  monthly_rent,
  vacancy_rate = 5,
  mgmt_fee_pct = 8,
  capex_reserve = 1200,
}) {
  logger.info('Running investment analysis', { address });

  // Fetch data in parallel
  const [propertyData, taxData, rentalData, currentRate] = await Promise.all([
    attomClient.getPropertyDetail(address).catch(() => ({})),
    taxAssessmentLookup({ address }).catch(() => ({})),
    !monthly_rent ? rentalComps({ address }).catch(() => null) : Promise.resolve(null),
    !interest_rate ? fredClient.getCurrentMortgageRate('30yr').catch(() => 7.0) : Promise.resolve(interest_rate),
  ]);

  // ── Income ───────────────────────────────────────────────────────────────
  const estimatedRent = monthly_rent
    || rentalData?.market_rent_estimate
    || estimateRentFromValue(purchase_price);

  const grossAnnualRent = estimatedRent * 12;
  const vacancyLoss     = grossAnnualRent * (vacancy_rate / 100);
  const effectiveGrossIncome = grossAnnualRent - vacancyLoss;

  // ── Expenses ─────────────────────────────────────────────────────────────
  // NJ property tax — use actual if we have it, otherwise estimate at 2.23%
  const annualTax = taxData?.annual_tax || purchase_price * 0.0223;

  const annualInsurance  = purchase_price * 0.006; // ~0.6% for NJ (higher near shore)
  const mgmtFee          = effectiveGrossIncome * (mgmt_fee_pct / 100);
  const maintenanceReserve = purchase_price * 0.01; // 1% rule
  const totalOpEx        = annualTax + annualInsurance + mgmtFee + maintenanceReserve + capex_reserve;

  // ── NOI ──────────────────────────────────────────────────────────────────
  const noi = effectiveGrossIncome - totalOpEx;

  // ── Cap Rate ─────────────────────────────────────────────────────────────
  const capRate = (noi / purchase_price) * 100;

  // ── Financing ────────────────────────────────────────────────────────────
  const downPayment  = purchase_price * (down_pct / 100);
  const loanAmount   = purchase_price - downPayment;
  const monthlyRate  = currentRate / 100 / 12;
  const numPayments  = 360; // 30yr
  const monthlyPI    = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments))
                                  / (Math.pow(1 + monthlyRate, numPayments) - 1);
  const annualDebtService = monthlyPI * 12;

  // ── Cash Flow ────────────────────────────────────────────────────────────
  const annualCashFlow   = noi - annualDebtService;
  const monthlyCashFlow  = annualCashFlow / 12;
  const cashOnCash       = (annualCashFlow / (downPayment + closingCosts(purchase_price))) * 100;
  const dscr             = noi / annualDebtService;

  // ── GRM ──────────────────────────────────────────────────────────────────
  const grm = purchase_price / grossAnnualRent;

  // ── Break-even occupancy ─────────────────────────────────────────────────
  const breakEvenOccupancy = ((totalOpEx + annualDebtService) / grossAnnualRent) * 100;

  // ── 5-year IRR projection ─────────────────────────────────────────────────
  const irr5yr = calc5YrIRR({
    purchase_price, downPayment, annualCashFlow,
    appreciation: 0.04, // NJ historical avg ~4%/yr
    closingCosts: closingCosts(purchase_price),
  });

  // ── NJ-specific flags ─────────────────────────────────────────────────────
  const flags = [];
  if (annualTax > purchase_price * 0.03) {
    flags.push(`⚠️  HIGH TAX: Effective rate ${((annualTax/purchase_price)*100).toFixed(2)}% — above NJ avg of 2.23%`);
  }
  if (capRate < 4) {
    flags.push(`⚠️  LOW CAP RATE: ${capRate.toFixed(2)}% — thin margin for NJ market`);
  }
  if (dscr < 1.2) {
    flags.push(`⚠️  LOW DSCR: ${dscr.toFixed(2)} — lenders typically want 1.25+`);
  }
  if (propertyData?.year_built && propertyData.year_built < 1978) {
    flags.push('⚠️  PRE-1978: Lead paint disclosure required (NJ law). Budget for potential remediation.');
  }

  // Check if municipality has rent control
  const rentControlMunis = getRentControlMunicipalities();
  const municipality = extractMunicipality(address);
  if (rentControlMunis.includes(municipality?.toLowerCase())) {
    flags.push(`⚠️  RENT CONTROL: ${municipality} has rent control ordinance — annual increase limited`);
  }

  // ── AI Narrative ─────────────────────────────────────────────────────────
  const narrative = await callClaude(`
Write a 2-paragraph investment analysis summary for a NJ real estate investor.
Property: ${address}
Purchase price: $${purchase_price?.toLocaleString()}
Cap rate: ${capRate.toFixed(2)}%
Cash-on-cash return: ${cashOnCash.toFixed(2)}%
Monthly cash flow: $${Math.round(monthlyCashFlow).toLocaleString()}
DSCR: ${dscr.toFixed(2)}
5-year IRR: ${irr5yr.toFixed(1)}%
Annual property tax: $${Math.round(annualTax).toLocaleString()} (${((annualTax/purchase_price)*100).toFixed(2)}% effective rate)
Flags: ${flags.length > 0 ? flags.join('; ') : 'None'}

Be direct about whether this is a strong, mediocre, or weak investment for NJ.
Context: NJ has nation's highest property taxes, strong tenant protections, but also
strong rent demand from NYC commuters and stable appreciation.
`);

  return {
    income: {
      gross_monthly_rent: estimatedRent,
      gross_annual_rent: grossAnnualRent,
      vacancy_loss: Math.round(vacancyLoss),
      effective_gross_income: Math.round(effectiveGrossIncome),
    },
    expenses: {
      annual_property_tax: Math.round(annualTax),
      tax_effective_rate: parseFloat(((annualTax/purchase_price)*100).toFixed(2)),
      annual_insurance: Math.round(annualInsurance),
      management_fee: Math.round(mgmtFee),
      maintenance_reserve: Math.round(maintenanceReserve),
      capex_reserve,
      total_opex: Math.round(totalOpEx),
    },
    financing: {
      loan_amount: Math.round(loanAmount),
      down_payment: Math.round(downPayment),
      interest_rate: currentRate,
      monthly_pi: Math.round(monthlyPI),
      annual_debt_service: Math.round(annualDebtService),
    },
    returns: {
      noi: Math.round(noi),
      cap_rate: parseFloat(capRate.toFixed(2)),
      cash_on_cash: parseFloat(cashOnCash.toFixed(2)),
      monthly_cash_flow: Math.round(monthlyCashFlow),
      annual_cash_flow: Math.round(annualCashFlow),
      dscr: parseFloat(dscr.toFixed(2)),
      grm: parseFloat(grm.toFixed(1)),
      break_even_occupancy: parseFloat(breakEvenOccupancy.toFixed(1)),
      irr_5yr: parseFloat(irr5yr.toFixed(1)),
    },
    flags,
    narrative,
    rent_source: monthly_rent ? 'user_provided' : (rentalData ? 'rental_comps' : 'estimated'),
    rental_comps: rentalData?.comps?.slice(0, 5) || [],
    generated_at: new Date().toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function closingCosts(price) {
  // NJ closing costs: typically 2-3% for buyer
  // Includes: title insurance, attorney fee, recording fees, NJ mansion tax (>$1M)
  let costs = price * 0.025;
  if (price > 1_000_000) costs += price * 0.01; // NJ mansion tax
  return costs;
}

function estimateRentFromValue(price) {
  // Rough rule of thumb for NJ: monthly rent ≈ 0.6-0.8% of value
  return Math.round(price * 0.007);
}

function calc5YrIRR({ purchase_price, downPayment, annualCashFlow, appreciation, closingCosts }) {
  const initialInvestment = downPayment + closingCosts;
  const salePrice5yr      = purchase_price * Math.pow(1 + appreciation, 5);
  const equityAtSale      = salePrice5yr - (purchase_price * 0.8); // rough equity after 5yr paydown
  const saleCosts         = salePrice5yr * 0.05; // agent fees + closing
  const netSaleProceeds   = equityAtSale - saleCosts;

  // Simple IRR approximation using Newton-Raphson
  const cashFlows = [-initialInvestment, ...Array(4).fill(annualCashFlow), annualCashFlow + netSaleProceeds];
  return calcIRR(cashFlows) * 100;
}

function calcIRR(cashFlows, guess = 0.1) {
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const npv  = cashFlows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + rate, t), 0);
    const dnpv = cashFlows.reduce((sum, cf, t) => sum - t * cf / Math.pow(1 + rate, t + 1), 0);
    const delta = npv / dnpv;
    rate -= delta;
    if (Math.abs(delta) < 1e-6) break;
  }
  return rate;
}

function getRentControlMunicipalities() {
  // NJ municipalities with active rent control ordinances (partial list)
  return [
    'asbury park', 'atlantic city', 'bayonne', 'bloomfield', 'camden',
    'east orange', 'elizabeth', 'englewood', 'fort lee', 'hackensack',
    'hoboken', 'irvington', 'jersey city', 'long branch', 'montclair',
    'morristown', 'new brunswick', 'newark', 'north bergen', 'nutley',
    'orange', 'passaic', 'paterson', 'perth amboy', 'plainfield',
    'red bank', 'roselle', 'south orange', 'teaneck', 'trenton',
    'union city', 'weehawken', 'west new york', 'woodbridge',
  ];
}

function extractMunicipality(address) {
  // Extract city/town from NJ address
  const parts = address.split(',');
  return parts.length >= 2 ? parts[parts.length - 2].trim() : null;
}
