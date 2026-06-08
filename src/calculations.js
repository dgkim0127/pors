export const KRW = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0
});

export function formatWon(value) {
  return KRW.format(Math.round(Number(value) || 0));
}

export function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function calculateSale(cartLines, customer) {
  const lineIsDiscountable = (line) => line?.categoryId !== "cat_no_discount" && line?.discountable !== false;
  const lineIsShipping = (line) => line?.name === "배송" || line?.name === "배송(양양)";
  const basePrice = (line) => line.originalPrice ?? line.price;
  const customerRate = Math.max(0, toNumber(customer?.discountRate)) / 100;
  const hasExclusiveCustomerDiscount = customerRate > 0 || Boolean(customer?.offshore);
  const subtotal = cartLines.reduce((sum, line) => sum + basePrice(line) * line.quantity, 0);
  const discountableSubtotal = cartLines
    .filter((line) => lineIsDiscountable(line))
    .reduce((sum, line) => sum + basePrice(line) * line.quantity, 0);
  const thresholdEligibleSubtotal = cartLines
    .filter((line) => (!line.originalPrice || line.originalPrice <= line.price) && !lineIsShipping(line))
    .reduce((sum, line) => sum + basePrice(line) * line.quantity, 0);
  const thresholdRate = hasExclusiveCustomerDiscount ? 0 : thresholdEligibleSubtotal >= 1000000 ? 0.1 : thresholdEligibleSubtotal >= 500000 ? 0.05 : 0;
  const discount = cartLines.reduce((sum, line) => {
    const directDiscount = hasExclusiveCustomerDiscount ? 0 : Math.max(0, basePrice(line) - line.price) * line.quantity;
    if (!lineIsDiscountable(line)) return sum + directDiscount;
    return sum + directDiscount + Math.round(basePrice(line) * line.quantity * customerRate);
  }, 0) + Math.round(thresholdEligibleSubtotal * thresholdRate);
  const afterDiscount = subtotal - discount;
  const vat = customer?.vatEnabled && !customer?.offshore ? Math.round(afterDiscount * 0.1) : 0;
  const total = afterDiscount + vat;

  return {
    subtotal,
    discountableSubtotal,
    discount,
    supply: afterDiscount,
    vat,
    total
  };
}

export function lineTotal(line) {
  return line.price * line.quantity;
}

export function normalizePercent(value) {
  return Math.max(0, Math.min(100, toNumber(value)));
}
