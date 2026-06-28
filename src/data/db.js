export const db = {
  connect: async () => { console.log('DB connected'); },
  query: async (sql, params) => ({ rows: [] }),
};
