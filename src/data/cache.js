export const cache = {
  connect: async () => { console.log('Cache connected'); },
  get: async (key) => null,
  set: async (key, val) => true,
  setex: async (key, ttl, val) => true,
  del: async (key) => true,
};
