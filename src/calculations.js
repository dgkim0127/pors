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

function excludesThresholdDiscountCustomer(customer) {
  return String(customer?.name ?? "").replace(/\s+/g, "").includes("\uB0A8\uB3C4\uB9C8\uCF13");
}

export function calculateSale(cartLines, customer, options = {}) {
  const lineIsDiscountable = (line) => line?.categoryId !== "cat_no_discount" && line?.discountable !== false;
  const lineIsShipping = (line) => line?.name === "\uBC30\uC1A1" || line?.name === "\uBC30\uC1A1(\uC591\uC591)";
  const excludesThresholdDiscount = excludesThresholdDiscountCustomer(customer);
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
  const discountForRatio = (ratio) => {
    const adjustedThresholdSubtotal = Math.round(thresholdEligibleSubtotal * ratio);
    const thresholdRate = hasExclusiveCustomerDiscount || excludesThresholdDiscount ? 0 : adjustedThresholdSubtotal >= 1000000 ? 0.1 : adjustedThresholdSubtotal >= 500000 ? 0.05 : 0;
    return cartLines.reduce((sum, line) => {
      const directDiscount = hasExclusiveCustomerDiscount ? 0 : Math.round(Math.max(0, basePrice(line) - line.price) * line.quantity * ratio);
      if (!lineIsDiscountable(line)) return sum + directDiscount;
      return sum + directDiscount + Math.round(basePrice(line) * line.quantity * ratio * customerRate);
    }, 0) + Math.round(adjustedThresholdSubtotal * thresholdRate);
  };
  const deduction = Math.min(subtotal, Math.max(0, Math.round(toNumber(options.deductionAmount))));
  const remainingRatio = subtotal > 0 ? (subtotal - deduction) / subtotal : 0;
  const beforeDeductionDiscount = discountForRatio(1);
  const discount = discountForRatio(remainingRatio);
  const beforeDeductionSupply = Math.max(0, subtotal - beforeDeductionDiscount);
  const beforeDeductionVat = customer?.vatEnabled && !customer?.offshore ? Math.round(beforeDeductionSupply * 0.1) : 0;
  const beforeDeductionTotal = beforeDeductionSupply + beforeDeductionVat;
  const deductionTaxIncluded = Boolean(options.deductionTaxIncluded);
  const supply = Math.max(0, subtotal - deduction - discount);
  const vat = customer?.vatEnabled && !customer?.offshore ? Math.round(supply * 0.1) : 0;
  const total = supply + vat;

  return {
    subtotal,
    discountableSubtotal,
    discount,
    supply,
    vat,
    beforeDeductionSupply,
    beforeDeductionTotal,
    deduction,
    deductionTaxIncluded,
    total
  };
}

export function lineTotal(line) {
  return line.price * line.quantity;
}

export function normalizePercent(value) {
  return Math.max(0, Math.min(100, toNumber(value)));
}
