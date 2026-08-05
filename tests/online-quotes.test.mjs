import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const React = {
  Fragment: Symbol("Fragment"),
  createElement() { return null; },
  useEffect() {},
  useMemo(factory) { return factory(); },
  useState(initialValue) {
    return [typeof initialValue === "function" ? initialValue() : initialValue, () => {}];
  },
};

const cache = new Map();
const windowObject = {
  React,
  crypto: { randomUUID() { return "test-id"; } },
  localStorage: {
    getItem(key) { return cache.get(key) || null; },
    removeItem(key) { cache.delete(key); },
    setItem(key, value) { cache.set(key, String(value)); },
  },
};
windowObject.window = windowObject;

const context = vm.createContext({
  React,
  clearTimeout,
  console,
  fetch: async () => ({ json: async () => ({}), ok: true }),
  setTimeout,
  window: windowObject,
});
const source = fs.readFileSync(new URL("../src/online-quotes.js", import.meta.url), "utf8");
const viteConfigSource = fs.readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
vm.runInContext(source, context);

assert.match(source, /readRequest\("\/pors\/quotes"\)/);
assert.match(source, /X-Pors-Quote-Read-Token/);
assert.match(source, /if \(features\(\)\.read\) loadQuotes\(\)/);
assert.doesNotMatch(source, /if \(user && features\(\)\.read\) loadQuotes\(\)/);
assert.match(source, /로그인 없이 조회 중입니다/);
assert.match(source, /disabled: !props\.online \|\| !props\.canWrite/);
assert.match(viteConfigSource, /PORS_NOBLESSE_READ_TOKEN/);
assert.match(viteConfigSource, /pors-device-config\.js/);

const {
  buildReceiptLinkPayload,
  buildWritePayload,
  draftFromQuote,
  groupPriceBands,
  optionPairs,
  quoteListQuantity,
  requestedQuantityFromDetail,
  resolveItemImage,
  webBuyerLabel,
} = windowObject.PorsOnlineQuotes.core;

const detail = {
  quote: {
    id: "quote-1",
    companyName: "Sample shop",
    items: [
      { id: "line-1", quantity: 3 },
      { id: "line-2", requestedQuantity: 2, confirmedQuantity: 1 },
    ],
  },
  pos: { state: { version: 4 }, pricing: { lines: [] } },
};

const draft = draftFromQuote(detail);
assert.deepEqual(JSON.parse(JSON.stringify(draft)), {
  items: [
    { cancellationNote: "", cancellationReason: "", id: "line-1", itemNote: "", preparedQuantity: 3 },
    { cancellationNote: "", cancellationReason: "", id: "line-2", itemNote: "", preparedQuantity: 1 },
  ],
});

draft.items[0].preparedQuantity = 99;
draft.items[1].cancellationReason = "out of stock";
const payload = buildWritePayload(detail, draft, "save");
assert.equal(payload.expectedVersion, 4);
assert.equal(payload.idempotencyKey, "save:test-id");
assert.equal(payload.items[0].preparedQuantity, 3);
assert.equal(payload.items[1].preparedQuantity, 1);
assert.equal("deductionAmount" in payload, false);
assert.equal("overrideUnitPrice" in payload.items[0], false);
assert.equal("overrideReason" in payload.items[1], false);

const missingCancellation = draftFromQuote(detail);
missingCancellation.items[0].preparedQuantity = 2;
assert.throws(() => buildWritePayload(detail, missingCancellation, "save"));

const receiptPayload = buildReceiptLinkPayload(detail, {
  id: "sale-1",
  customerName: "PORS customer",
  createdAt: "2026-08-04T00:00:00.000Z",
  lines: [{ id: "line" }],
  totals: { supply: 3600, vat: 360, total: 3960 },
});
assert.equal(receiptPayload.expectedVersion, 4);
assert.equal(receiptPayload.idempotencyKey, "receipt-link:test-id");
assert.equal(receiptPayload.receiptId, "sale-1");
assert.deepEqual(JSON.parse(JSON.stringify(receiptPayload.receiptSnapshot)), {
  saleId: "sale-1",
  customerName: "PORS customer",
  createdAt: "2026-08-04T00:00:00.000Z",
  supplyAmount: 3600,
  vatAmount: 360,
  totalAmount: 3960,
  lineCount: 1,
});
assert.throws(() => buildReceiptLinkPayload(detail, null));

assert.equal(webBuyerLabel({ companyName: "Sample shop" }), "웹-Sample shop");
assert.equal(webBuyerLabel({}), "웹-웹 거래처");
assert.equal(
  requestedQuantityFromDetail({
    items: [
      { requestedQuantity: 3 },
      { quantity: 2 },
      { requestedQuantity: 0 },
    ],
  }),
  5,
);
assert.equal(requestedQuantityFromDetail({}), null);
assert.equal(quoteListQuantity({ requestedQuantity: 7, itemCount: 2 }), 7);
assert.equal(quoteListQuantity({ items: [{ requestedQuantity: 4 }] }), 4);
assert.equal(quoteListQuantity({ itemCount: 3 }), 3);
assert.match(source, /className: "online-quotes-refresh"/);
assert.match(source, /"aria-label": "새로고침"/);
assert.match(source, /className: "online-quotes-toolbar"/);
assert.match(source, /online-quote-list-row__chevron/);
assert.match(source, /online-quote-list-row__summary/);
assert.doesNotMatch(source, /h\("small", null, quote\.inquiryNumber/);
assert.doesNotMatch(source, /className: "online-quote-status" }, statusLabel\(quote\)/);

assert.deepEqual(
  JSON.parse(JSON.stringify(optionPairs({ selectedOptions: [{ groupLabel: "color", valueLabel: "gold" }, { groupName: "size", valueName: "6mm" }] }))),
  [{ label: "color", value: "gold" }, { label: "size", value: "6mm" }],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(groupPriceBands({ lines: [{ quantity: 2, unitPrice: 1800 }, { preparedQuantity: 3, unitPrice: 1800 }, { quantity: 1, unitPrice: 2200 }] }))),
  [{ quantity: 5, unitPrice: 1800 }, { quantity: 1, unitPrice: 2200 }],
);
assert.equal(
  resolveItemImage({ imageSet: { gallery: [{ urls: { thumb: "https://example.test/thumb.webp" } }] } }),
  "https://example.test/thumb.webp",
);

console.log("online quote workspace tests passed");
