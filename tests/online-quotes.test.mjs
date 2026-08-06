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
assert.match(source, /var writeToken = String\(global\.PORS_NOBLESSE_WRITE_TOKEN \|\| ""\)\.trim\(\)/);
assert.match(source, /deviceWriteRequest\(/);
assert.match(source, /X-Pors-Quote-Write-Token/);
assert.match(source, /"\/pors\/quotes\/" \+ encodeURIComponent\(quote\.id\) \+ path/);
assert.match(source, /if \(features\(\)\.read\) loadQuotes\(\)/);
assert.doesNotMatch(source, /OnlineQuoteLogin/);
assert.doesNotMatch(source, /getNamedAuth/);
assert.doesNotMatch(source, /\/admin\/pos\/quotes/);
assert.doesNotMatch(source, /작업 로그인/);
assert.doesNotMatch(source, /online-quotes-eyebrow" }, statusLabel/);
assert.match(source, /await loadQuoteDetail\(quote\.id\)/);
assert.match(source, /disabled: !props\.online \|\| !props\.canWrite/);
assert.match(viteConfigSource, /PORS_NOBLESSE_READ_TOKEN/);
assert.match(viteConfigSource, /PORS_NOBLESSE_WRITE_TOKEN/);
assert.match(viteConfigSource, /pors-device-config\.js/);

const {
  apiErrorMessage,
  buildReceiptLinkPayload,
  buildWritePayload,
  draftFromQuote,
  groupPriceBands,
  optionPairs,
  pricingFromDetail,
  publicationIsCurrent,
  quoteItemsFromDetail,
  quoteReceiptLines,
  quoteListQuantity,
  quoteWriteMetadata,
  requestedQuantityFromDetail,
  resolveItemImage,
  webBuyerLabel,
} = windowObject.PorsOnlineQuotes.core;

assert.equal(
  apiErrorMessage({ error: { code: "VALIDATION_ERROR", message: "내부 견적을 먼저 확정해 주세요." } }, "작업에 실패했습니다."),
  "내부 견적을 먼저 확정해 주세요.",
);
assert.equal(
  apiErrorMessage({ error: { code: "INTERNAL_ERROR" } }, "작업에 실패했습니다."),
  "작업에 실패했습니다.",
);

assert.deepEqual(
  JSON.parse(JSON.stringify(quoteWriteMetadata({ quote: {
    leadTime: { unexpected: true },
    shippingNote: null,
    validUntil: { unexpected: true },
    documentLocale: { unexpected: true },
    customerNote: ["unexpected"],
    adminMemo: 1,
  } }))),
  {
    leadTime: "",
    shippingNote: "",
    validUntil: quoteWriteMetadata({}).validUntil,
    documentLocale: "kr",
    customerNote: "",
    adminMemo: "",
  },
);

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
    { cancellationNote: "", cancellationReason: "", id: "line-1", itemNote: "", preparationMarked: false, preparedQuantity: 3 },
    { cancellationNote: "", cancellationReason: "", id: "line-2", itemNote: "", preparationMarked: false, preparedQuantity: 1 },
  ],
});

const topLevelItemsDetail = {
  quote: { id: "quote-2", companyName: "Top level shop" },
  items: [{ id: "line-3", requestedQuantity: 2, confirmedQuantity: 1 }],
  pos: { state: { version: 7 } },
};
assert.deepEqual(
  JSON.parse(JSON.stringify(quoteItemsFromDetail(topLevelItemsDetail))),
  [{ id: "line-3", requestedQuantity: 2, confirmedQuantity: 1 }],
);
assert.deepEqual(JSON.parse(JSON.stringify(draftFromQuote(topLevelItemsDetail))), {
  items: [
    { cancellationNote: "", cancellationReason: "", id: "line-3", itemNote: "", preparationMarked: false, preparedQuantity: 1 },
  ],
});

const finalizedDetail = {
  quote: { id: "quote-finalized" },
  items: [{
    id: "line-ready",
    requestedQuantity: 2,
    confirmedQuantity: 2,
    fulfillmentStatus: "ready",
  }],
  pos: {
    state: {
      finalizedAt: "2026-08-06T01:00:00.000Z",
      finalizedSnapshot: { pricing: { totalAmount: 3960, lines: [] } },
    },
  },
};
assert.equal(draftFromQuote(finalizedDetail).items[0].preparationMarked, true);
assert.deepEqual(
  JSON.parse(JSON.stringify(pricingFromDetail(finalizedDetail))),
  { totalAmount: 3960, lines: [] },
);
assert.equal(publicationIsCurrent(finalizedDetail), false);
assert.equal(publicationIsCurrent({
  pos: { state: {
    finalizedAt: "2026-08-06T01:00:00.000Z",
    publishedAt: "2026-08-06T01:01:00.000Z",
  } },
}), true);
assert.equal(publicationIsCurrent({
  pos: { state: {
    finalizedAt: "2026-08-06T01:02:00.000Z",
    publishedAt: "2026-08-06T01:01:00.000Z",
  } },
}), false);

draft.items[0].preparedQuantity = 99;
draft.items[1].cancellationReason = "out of stock";
const payload = buildWritePayload(detail, draft, "save");
assert.equal(payload.expectedVersion, 4);
assert.equal(payload.idempotencyKey, "save:test-id");
assert.equal(payload.items[0].preparedQuantity, 3);
assert.equal(payload.items[1].preparedQuantity, 1);
assert.equal(payload.documentLocale, "kr");
assert.match(payload.validUntil, /^\d{4}-\d{2}-\d{2}$/);
assert.equal("deductionAmount" in payload, false);
assert.equal("overrideUnitPrice" in payload.items[0], false);
assert.equal("overrideReason" in payload.items[1], false);

const missingCancellation = draftFromQuote(detail);
missingCancellation.items[0].preparedQuantity = 2;
assert.throws(() => buildWritePayload(detail, missingCancellation, "save"));

const partialDraft = draftFromQuote(detail);
partialDraft.items[0].preparedQuantity = 2;
partialDraft.items[0].cancellationReason = "수량 부족";
partialDraft.items[1].preparedQuantity = 2;
assert.equal(
  buildWritePayload(detail, partialDraft, "save").items[0].cancellationReason,
  "quantity_shortage",
);

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
assert.match(source, /"부분 준비"/);
assert.match(source, /준비 가능한 수량을 입력하세요\./);
assert.match(source, /online-quote-item--sold-out/);
assert.match(source, /label: "갯수", value: quantity \+ "개"/);
assert.doesNotMatch(source, /h\("span", null, "요청 ", h\("b", null, requested\)\)/);
assert.doesNotMatch(source, /online-quote-quantity-summary/);
assert.match(source, /preparationMarked \? "is-active" : "is-inactive"/);
assert.match(source, /h\("span", null, "준비"\)/);
assert.match(source, /online-quote-quantity-stepper/);
assert.match(source, /function previewPreparation\(itemId, patch\)/);
assert.match(source, /writeQuote\("preview", "\/price-preview", "", nextDraft\)/);
assert.match(source, /onPreparationSelected: previewPreparation/);
assert.match(source, /var canWrite = props\.online && props\.canWrite && !props\.busy/);
assert.match(source, /\(finalized && !props\.dirty\)/);
assert.match(source, /props\.dirty \|\| !finalized \|\| published/);
assert.match(source, /props\.dirty \? "견적 다시 확정" : "견적 확정됨"/);
assert.doesNotMatch(source, /가격 다시 계산/);
assert.match(source, /준비 수량 1개 줄이기/);
assert.match(source, /준비 수량 1개 늘리기/);
assert.doesNotMatch(source, /h\("small", null, quote\.inquiryNumber/);
assert.doesNotMatch(source, /className: "online-quote-status" }, statusLabel\(quote\)/);
assert.doesNotMatch(source, /h\("p", null, webBuyerLabel\(quote\)\)/);

assert.deepEqual(
  JSON.parse(JSON.stringify(optionPairs({ selectedOptions: [{ groupLabel: "color", valueLabel: "gold" }, { groupName: "size", valueName: "6mm" }] }))),
  [{ label: "color", value: "gold" }, { label: "size", value: "6mm" }],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(optionPairs({ selectedOptions: [], color: "gold", size: "6mm", barLength: "8mm" }))),
  [{ label: "색상", value: "gold" }, { label: "바 길이", value: "8mm" }, { label: "바 길이/사이즈", value: "6mm" }],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(groupPriceBands({ lines: [{ quantity: 2, unitPrice: 1800 }, { preparedQuantity: 3, unitPrice: 1800 }, { quantity: 1, unitPrice: 2200 }] }))),
  [{ quantity: 5, unitPrice: 1800 }, { quantity: 1, unitPrice: 2200 }],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(quoteReceiptLines(
    { lines: [{ itemId: "line-1", preparedQuantity: 2, unitPrice: 1800, lineSubtotal: 3600 }] },
    [{ id: "line-1", productName: "Clover barbell" }],
  ))),
  [{ id: "line-1", name: "Clover barbell", quantity: 2, unitPrice: 1800, subtotal: 3600 }],
);
assert.doesNotMatch(source, /웹 견적 · 할인 0% 고정/);
assert.match(source, /online-quote-receipt__store/);
assert.equal(
  resolveItemImage({ imageSet: { gallery: [{ urls: { thumb: "https://example.test/thumb.webp" } }] } }),
  "https://example.test/thumb.webp",
);
assert.equal(
  resolveItemImage({ productImage: { url: "https://example.test/product.webp" } }),
  "https://example.test/product.webp",
);
windowObject.PORS_NOBLESSE_API_BASE_URL = "https://noblesse.web.app/api";
assert.equal(
  resolveItemImage({ productImage: { url: "/storage/product.webp" } }),
  "https://noblesse.web.app/storage/product.webp",
);

console.log("online quote workspace tests passed");
