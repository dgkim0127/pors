import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const React = {
  Fragment: Symbol("Fragment"),
  createElement() {
    return null;
  },
  useEffect() {},
  useMemo(factory) {
    return factory();
  },
  useState(initialValue) {
    return [
      typeof initialValue === "function" ? initialValue() : initialValue,
      () => {},
    ];
  },
};

const cache = new Map();
const windowObject = {
  React,
  crypto: {
    randomUUID() {
      return "test-id";
    },
  },
  localStorage: {
    getItem(key) {
      return cache.get(key) || null;
    },
    removeItem(key) {
      cache.delete(key);
    },
    setItem(key, value) {
      cache.set(key, String(value));
    },
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
const source = fs.readFileSync(
  new URL("../src/online-quotes.js", import.meta.url),
  "utf8",
);
vm.runInContext(source, context);

const {
  buildWritePayload,
  draftFromQuote,
  groupPriceBands,
  isLinkedCustomer,
  normalizeCatalogCustomer,
  normalizeCatalogItem,
  optionPairs,
  resolveItemImage,
} = windowObject.PorsOnlineQuotes.core;

const detail = {
  quote: {
    items: [
      { id: "line-1", quantity: 3 },
      { id: "line-2", requestedQuantity: 2, confirmedQuantity: 1 },
    ],
  },
  pos: {
    pricing: {
      deductionAmount: 250,
      lines: [
        {
          itemId: "line-2",
          overrideReason: "manual quote",
          overrideUnitPrice: 1900,
        },
      ],
    },
    state: { version: 4 },
  },
};

const draft = draftFromQuote(detail);
assert.deepEqual(
  JSON.parse(JSON.stringify(draft)),
  {
    deductionAmount: 250,
    items: [
      {
        cancellationNote: "",
        cancellationReason: "",
        id: "line-1",
        itemNote: "",
        overrideReason: "",
        overrideUnitPrice: "",
        posItemId: "",
        preparedQuantity: 3,
      },
      {
        cancellationNote: "",
        cancellationReason: "",
        id: "line-2",
        itemNote: "",
        overrideReason: "manual quote",
        overrideUnitPrice: "1900",
        posItemId: "",
        preparedQuantity: 1,
      },
    ],
  },
);

draft.items[0].preparedQuantity = 99;
draft.items[1].cancellationReason = "out of stock";
const payload = buildWritePayload(detail, draft, "save");
assert.equal(payload.expectedVersion, 4);
assert.equal(payload.idempotencyKey, "save:test-id");
assert.equal(payload.items[0].preparedQuantity, 3);
assert.equal(payload.items[1].preparedQuantity, 1);
assert.equal(payload.items[1].overrideUnitPrice, 1900);
assert.equal(payload.items[1].overrideReason, "manual quote");

const missingCancellation = draftFromQuote(detail);
missingCancellation.items[0].preparedQuantity = 2;
assert.throws(
  () => buildWritePayload(detail, missingCancellation, "save"),
  /취소 사유/,
);

const missingOverrideReason = draftFromQuote(detail);
missingOverrideReason.items[0].overrideUnitPrice = "2100";
assert.throws(
  () => buildWritePayload(detail, missingOverrideReason, "preview"),
  /수정 사유/,
);

assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      optionPairs({
        selectedOptions: [
          { groupLabel: "색상", valueLabel: "골드" },
          { groupName: "바 길이", valueName: "6mm" },
          { groupLabel: "빈 값", valueLabel: "" },
        ],
      }),
    ),
  ),
  [
    { label: "색상", value: "골드" },
    { label: "바 길이", value: "6mm" },
  ],
);
assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      optionPairs({
        selectedOptions: {
          gauge: { label: "16G" },
          thickness: "1.2mm",
        },
      }),
    ),
  ),
  [
    { label: "gauge", value: "16G" },
    { label: "thickness", value: "1.2mm" },
  ],
);
assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      optionPairs({ selectedColor: "Pink", selectedSize: "8mm" }),
    ),
  ),
  [
    { label: "색상", value: "Pink" },
    { label: "사이즈", value: "8mm" },
  ],
);

assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      groupPriceBands({
        lines: [
          { quantity: 2, unitPrice: 1800 },
          { preparedQuantity: 3, unitPrice: 1800 },
          { quantity: 1, unitPrice: 2200 },
        ],
      }),
    ),
  ),
  [
    { quantity: 5, unitPrice: 1800 },
    { quantity: 1, unitPrice: 2200 },
  ],
);

assert.equal(isLinkedCustomer({ connectionStatus: "linked" }), true);
assert.equal(isLinkedCustomer({ source: "general" }), false);

assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      normalizeCatalogCustomer({
        active: true,
        discountRate: "7.5",
        id: 10,
        name: "Sample shop",
        offshore: true,
        vatEnabled: false,
      }),
    ),
  ),
  {
    active: true,
    discountRate: 7.5,
    id: "10",
    name: "Sample shop",
    overseas: true,
    pricingRules: [],
    vatEnabled: false,
  },
);

assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      normalizeCatalogItem({
        active: true,
        code: "P-1",
        discountable: false,
        id: 20,
        name: "Barbell",
        price: "1800",
      }),
    ),
  ),
  {
    active: true,
    basePrice: 1800,
    code: "P-1",
    discountable: false,
    id: "20",
    name: "Barbell",
    pricingRules: {},
  },
);

assert.equal(
  resolveItemImage({
    imageSet: {
      gallery: [{ urls: { thumb: "https://example.test/thumb.webp" } }],
    },
  }),
  "https://example.test/thumb.webp",
);
assert.equal(
  resolveItemImage({
    imageSet: { card: "https://example.test/card.webp" },
  }),
  "https://example.test/card.webp",
);

console.log("online quote workspace tests passed");
