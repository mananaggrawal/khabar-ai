/**
 * File-based mock Supabase client for LOCAL_MODE.
 * Stores each table as a JSON file under .local-data/.
 * Implements just the query API surface the app uses.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".local-data");
export const LOCAL_USER_ID = "local-user";

async function readTable<T>(table: string): Promise<T[]> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await readFile(join(DATA_DIR, `${table}.json`), "utf-8"));
  } catch {
    return [];
  }
}

async function writeTable<T>(table: string, rows: T[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, `${table}.json`), JSON.stringify(rows, null, 2));
}

function applyFilters(rows: any[], filters: Array<[string, any, any]>): any[] {
  return rows.filter((row) =>
    filters.every(([op, col, val]) => {
      if (op === "eq") return row[col] === val;
      if (op === "gte") return row[col] >= val;
      return true;
    }),
  );
}

class QueryBuilder {
  private _table: string;
  private _filters: Array<[string, any, any]> = [];
  private _orderCol: string | null = null;
  private _orderAsc = true;
  private _limitN: number | null = null;
  private _insertData: any = null;
  private _updateData: any = null;
  private _upsertData: any = null;

  constructor(table: string) {
    this._table = table;
  }

  select(_cols: string) { return this; }
  eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; }
  gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; }
  order(col: string, opts?: { ascending?: boolean }) {
    this._orderCol = col;
    this._orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) { this._limitN = n; return this; }
  insert(data: any) { this._insertData = data; return this; }
  update(data: any) { this._updateData = data; return this; }
  upsert(data: any) { this._upsertData = data; return this; }

  async single() { this._limitN = 1; return this._run(); }
  async maybeSingle() { this._limitN = 1; return this._run(); }

  // Make awaitable without a terminal call (e.g. await supabase.from().update().eq())
  then(resolve: (v: any) => void, reject: (e: any) => void) {
    return this._run().then(resolve, reject);
  }

  private async _run(): Promise<{ data: any; error: any }> {
    // INSERT
    if (this._insertData !== null) {
      const rows = await readTable<any>(this._table);
      const row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        generated_at: new Date().toISOString(),
        user_id: LOCAL_USER_ID,
        ...this._insertData,
      };
      rows.push(row);
      await writeTable(this._table, rows);
      return { data: row, error: null };
    }

    // UPSERT
    if (this._upsertData !== null) {
      const rows = await readTable<any>(this._table);
      const data = { user_id: LOCAL_USER_ID, ...this._upsertData };
      const idx = rows.findIndex((r) => r.user_id === LOCAL_USER_ID);
      if (idx >= 0) rows[idx] = { ...rows[idx], ...data };
      else rows.push(data);
      await writeTable(this._table, rows);
      return { data: null, error: null };
    }

    // UPDATE
    if (this._updateData !== null) {
      const rows = await readTable<any>(this._table);
      const updated = rows.map((r) => {
        const passes = applyFilters([r], this._filters).length > 0;
        return passes ? { ...r, ...this._updateData } : r;
      });
      await writeTable(this._table, updated);
      return { data: null, error: null };
    }

    // SELECT
    let rows = await readTable<any>(this._table);
    rows = applyFilters(rows, this._filters);
    if (this._orderCol) {
      const col = this._orderCol;
      const asc = this._orderAsc;
      rows = rows.sort((a, b) => (a[col] < b[col] ? (asc ? -1 : 1) : a[col] > b[col] ? (asc ? 1 : -1) : 0));
    }
    if (this._limitN !== null) rows = rows.slice(0, this._limitN);

    // single / maybeSingle behaviour
    if (this._limitN === 1) return { data: rows[0] ?? null, error: null };
    return { data: rows.length > 0 ? rows : null, error: null };
  }
}

export function createLocalClient() {
  return {
    from: (table: string) => new QueryBuilder(table),
  };
}
