import { makeId } from "./calculations.js";

const STORE_KEY = "piercing-pos-state-v1";

export const seedData = {
  store: {
    id: "store_demo",
    name: "피어싱 계산",
    adminKey: "0000"
  },
  categories: [
    { id: "cat_earring", name: "귀걸이", sort: 1, discountableDefault: true, active: true },
    { id: "cat_silver", name: "실버", sort: 2, discountableDefault: true, active: true },
    { id: "cat_other", name: "기타", sort: 3, discountableDefault: true, active: true },
    { id: "cat_parts", name: "부자재", sort: 4, discountableDefault: true, active: true },
    { id: "cat_no_discount", name: "할인 안됨", sort: 5, discountableDefault: false, active: true }
  ],
  items: [
    { id: "item_earring_1000", categoryId: "cat_earring", name: "귀걸이 1,000", price: 1000, discountable: true, active: true },
    { id: "item_earring_2000", categoryId: "cat_earring", name: "귀걸이 2,000", price: 2000, discountable: true, active: true },
    { id: "item_silver_3000", categoryId: "cat_silver", name: "실버 3,000", price: 3000, discountable: true, active: true },
    { id: "item_pearl", categoryId: "cat_other", name: "진주", price: 0, discountable: true, active: true },
    { id: "item_coating", categoryId: "cat_other", name: "코팅", price: 0, discountable: true, active: true },
    { id: "item_parts", categoryId: "cat_parts", name: "부자재", price: 0, discountable: true, active: true },
    { id: "item_fixed", categoryId: "cat_no_discount", name: "할인 제외", price: 0, discountable: false, active: true }
  ],
  customers: [
    { id: "customer_walkin", name: "일반", discountRate: 0, vatEnabled: false, active: true },
    { id: "customer_shop", name: "거래처", discountRate: 10, vatEnabled: true, active: true }
  ],
  sales: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readEnv() {
  return {
    url: window.PIERCE_SUPABASE_URL || "",
    anonKey: window.PIERCE_SUPABASE_ANON_KEY || "",
    adminKey: window.PIERCE_ADMIN_KEY || ""
  };
}

class LocalRepository {
  constructor() {
    this.mode = "local";
  }

  load() {
    const saved = localStorage.getItem(STORE_KEY);
    if (!saved) {
      localStorage.setItem(STORE_KEY, JSON.stringify(seedData));
      return clone(seedData);
    }
    return { ...clone(seedData), ...JSON.parse(saved) };
  }

  save(state) {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return clone(state);
  }

  verifyAdminKey(key) {
    const state = this.load();
    const env = readEnv();
    return key === state.store.adminKey || (!!env.adminKey && key === env.adminKey);
  }
}

class SupabaseRestRepository extends LocalRepository {
  constructor(url, anonKey) {
    super();
    this.mode = "supabase";
    this.url = url.replace(/\/$/, "");
    this.anonKey = anonKey;
  }

  headers(extra = {}) {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.anonKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extra
    };
  }

  async fetchTable(table) {
    const response = await fetch(`${this.url}/rest/v1/${table}?select=*`, { headers: this.headers() });
    if (!response.ok) throw new Error(`${table} 조회 실패`);
    return response.json();
  }

  async load() {
    try {
      const [stores, categories, items, customers, sales, saleLines] = await Promise.all([
        this.fetchTable("stores"),
        this.fetchTable("categories"),
        this.fetchTable("items"),
        this.fetchTable("customers"),
        this.fetchTable("sales"),
        this.fetchTable("sale_lines")
      ]);
      const linesBySale = saleLines.reduce((map, line) => {
        map[line.sale_id] = map[line.sale_id] || [];
        map[line.sale_id].push(line);
        return map;
      }, {});
      return {
        store: stores[0] || seedData.store,
        categories: categories.map(mapCategory),
        items: items.map(mapItem),
        customers: customers.map(mapCustomer),
        sales: sales.map((sale) => mapSale(sale, linesBySale[sale.id] || []))
      };
    } catch (error) {
      console.warn("Supabase unavailable, using local data", error);
      return super.load();
    }
  }

  async save(state) {
    super.save(state);
    return clone(state);
  }
}

function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
    sort: row.sort_order,
    discountableDefault: row.discountable_default,
    active: row.active
  };
}

function mapItem(row) {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    price: row.price,
    discountable: row.discountable,
    active: row.active
  };
}

function mapCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    discountRate: row.discount_rate,
    vatEnabled: row.vat_enabled,
    active: row.active
  };
}

function mapSale(row, lines) {
  return {
    id: row.id,
    createdAt: row.created_at,
    customerId: row.customer_id,
    customerName: row.customer_name,
    totals: {
      subtotal: row.subtotal,
      discount: row.discount,
      supply: row.supply,
      vat: row.vat,
      total: row.total
    },
    lines: lines.map((line) => ({
      id: line.id,
      itemId: line.item_id,
      name: line.item_name,
      quantity: line.quantity,
      price: line.price,
      discountable: line.discountable
    }))
  };
}

export function createRepository() {
  const env = readEnv();
  if (env.url && env.anonKey) return new SupabaseRestRepository(env.url, env.anonKey);
  return new LocalRepository();
}

export function createCategory(name, discountableDefault) {
  return {
    id: makeId("cat"),
    name,
    sort: Date.now(),
    discountableDefault,
    active: true
  };
}

export function createItem({ name, price, categoryId, discountable }) {
  return {
    id: makeId("item"),
    name,
    price,
    categoryId,
    discountable,
    active: true
  };
}

export function createCustomer({ name, discountRate, vatEnabled }) {
  return {
    id: makeId("customer"),
    name,
    discountRate,
    vatEnabled,
    active: true
  };
}
