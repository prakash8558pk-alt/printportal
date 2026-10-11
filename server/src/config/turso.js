import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';

export const db = createClient({ url: process.env.TURSO_DATABASE_URL || 'file:local.db', authToken: process.env.TURSO_AUTH_TOKEN });
const tables = ['users', 'organizations', 'requests', 'tokens'];
export async function initDatabase() {
  await db.batch(tables.map(t => `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`), 'write');
  await db.batch([
    "CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(json_extract(data,'$.email'))",
    "CREATE INDEX IF NOT EXISTS users_org_role ON users(json_extract(data,'$.organization'), json_extract(data,'$.role'))",
    "CREATE INDEX IF NOT EXISTS requests_org_employee ON requests(json_extract(data,'$.organization'),json_extract(data,'$.employee'))",
    "CREATE INDEX IF NOT EXISTS requests_org_status ON requests(json_extract(data,'$.organization'),json_extract(data,'$.status'))",
    "CREATE UNIQUE INDEX IF NOT EXISTS tokens_token ON tokens(json_extract(data,'$.token'))",
    "CREATE INDEX IF NOT EXISTS tokens_user ON tokens(json_extract(data,'$.user'))"
  ], 'write');
  await db.execute('CREATE TABLE IF NOT EXISTS print_files (id TEXT PRIMARY KEY, organization TEXT NOT NULL, employee TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL, content BLOB NOT NULL)');
  await db.execute({ sql: "DELETE FROM tokens WHERE json_extract(data,'$.expiresAt') < ?", args: [new Date().toISOString()] });
}

// Small SQL-backed compatibility layer for this application's existing controllers.
// Every filter value is bound as a parameter. Only internal field names become SQL.
function where(filter = {}) {
  const args = [];
  const clauses = Object.entries(filter).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid field');
    const column = key === '_id' ? 'id' : `json_extract(data,'$.${key}')`;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$ne' in value) { args.push(value.$ne); return `${column} != ?`; }
      if ('$in' in value && Array.isArray(value.$in)) { args.push(...value.$in); return `${column} IN (${value.$in.map(() => '?').join(',') || 'NULL'})`; }
      throw new Error('Unsupported filter');
    }
    args.push(value instanceof Date ? value.toISOString() : value);
    return `${column} = ?`;
  });
  return { sql: clauses.length ? clauses.join(' AND ') : '1=1', args };
}

export function model(table, defaults = {}) {
  if (!tables.includes(table)) throw new Error('Unknown table');
  function hydrate(raw) {
    if (!raw) return null;
    const document = JSON.parse(raw.data);
    for (const field of ['createdAt', 'updatedAt', 'expiresAt', 'lastLogin', 'dueDateTime']) {
      if (document[field]) document[field] = new Date(document[field]);
    }
    Object.defineProperty(document, 'save', { enumerable: false, value: async () => {
      document.updatedAt = new Date();
      // Preserve non-selected fields, such as password, when saving a projection.
      const previous = await db.execute({ sql: `SELECT data FROM ${table} WHERE id=?`, args: [document._id] });
      if (!previous.rows[0]) throw new Error('Record no longer exists');
      const merged = { ...JSON.parse(previous.rows[0].data), ...document };
      await db.execute({ sql: `UPDATE ${table} SET data=? WHERE id=?`, args: [JSON.stringify(merged), document._id] });
      return document;
    }});
    Object.defineProperty(document, 'deleteOne', { enumerable: false, value: () => api.deleteOne({ _id: document._id }) });
    return document;
  }
  class Query {
    constructor(filter, single = false) { this.filter = filter; this.single = single; this.offset = 0; this.maximum = single ? 1 : 1000; }
    select(fields) { this.fields = fields; return this; }
    sort(fields) { this.order = fields; return this; }
    skip(value) { this.offset = Math.max(0, Number(value) || 0); return this; }
    limit(value) { this.maximum = Math.min(1000, Math.max(1, Number(value) || 10)); return this; }
    populate(field, fields) { this.populateField = field; this.populateFields = fields; return this; }
    async execute() {
      const filter = where(this.filter);
      let order = '';
      if (this.order) {
        const [field, direction] = Object.entries(this.order)[0];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error('Invalid order');
        order = ` ORDER BY json_extract(data,'$.${field}') ${direction === -1 ? 'DESC' : 'ASC'}`;
      }
      const result = await db.execute({ sql: `SELECT data FROM ${table} WHERE ${filter.sql}${order} LIMIT ? OFFSET ?`, args: [...filter.args, this.maximum, this.offset] });
      const documents = result.rows.map(hydrate);
      for (const document of documents) {
        if (table === 'users' && this.fields !== '+password') delete document.password;
        if (this.populateField) {
          const linked = await model('users').findById(document[this.populateField]);
          document[this.populateField] = linked && this.populateFields ? Object.fromEntries(['_id', ...this.populateFields.split(' ')].map(k => [k, linked[k]])) : linked;
        }
      }
      return this.single ? documents[0] || null : documents;
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  const api = {
    find: filter => new Query(filter),
    findOne: filter => new Query(filter, true),
    findById: id => new Query({ _id: String(id) }, true),
    async create(input) {
      const document = { ...defaults, ...input, _id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
      if (document.email) document.email = document.email.trim().toLowerCase();
      await db.execute({ sql: `INSERT INTO ${table}(id,data) VALUES (?,?)`, args: [document._id, JSON.stringify(document)] });
      return hydrate({ data: JSON.stringify(document) });
    },
    async countDocuments(filter) {
      const query = where(filter);
      const result = await db.execute({ sql: `SELECT count(*) AS count FROM ${table} WHERE ${query.sql}`, args: query.args });
      return Number(result.rows[0].count);
    },
    async deleteMany(filter) {
      const query = where(filter);
      return db.execute({ sql: `DELETE FROM ${table} WHERE ${query.sql}`, args: query.args });
    },
    async deleteOne(filter) { return api.deleteMany(filter); },
    async findByIdAndDelete(id) { return api.deleteOne({ _id: String(id) }); },
    async aggregate(stages) {
      const query = where(stages[0].$match);
      const result = await db.execute({ sql: `SELECT json_extract(data,'$.status') AS _id,count(*) AS count FROM ${table} WHERE ${query.sql} GROUP BY json_extract(data,'$.status')`, args: query.args });
      return result.rows.map(row => ({ _id: row._id, count: Number(row.count) }));
    }
  };
  return api;
}
