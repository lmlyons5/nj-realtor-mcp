export const mlsClient = {
  getPropertyByAddress: async (addr) => null,
  getSoldComps: async (opts) => [],
  getActiveListings: async (opts) => [],
  getModifiedSince: async (source, date) => [],
  getLocalMarketStats: async (opts) => ({ median_list: 0, median_sold: 0, avg_dom: 0, l2s_ratio: 0, active_count: 0, sold_90d: 0, yoy_change: 0 }),
};
