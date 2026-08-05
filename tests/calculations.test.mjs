import assert from "node:assert/strict";
import { calculateSale } from "../src/calculations.js";

const cart = [
  { price: 1000, quantity: 2, discountable: true },
  { price: 3000, quantity: 1, discountable: true },
  { price: 5000, quantity: 1, discountable: false }
];

{
  const totals = calculateSale(cart, { discountRate: 10, vatEnabled: true });
  assert.equal(totals.subtotal, 10000);
  assert.equal(totals.discountableSubtotal, 5000);
  assert.equal(totals.discount, 500);
  assert.equal(totals.supply, 9500);
  assert.equal(totals.vat, 950);
  assert.equal(totals.total, 10450);
}

{
  const totals = calculateSale(cart, { discountRate: 10, vatEnabled: false });
  assert.equal(totals.vat, 0);
  assert.equal(totals.total, 9500);
}

{
  const totals = calculateSale(cart, { discountRate: 0, vatEnabled: true });
  assert.equal(totals.discount, 0);
  assert.equal(totals.vat, 1000);
  assert.equal(totals.total, 11000);
}

{
  const totals = calculateSale([{ price: 1000, quantity: 50, discountable: true }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 50000);
}

{
  const totals = calculateSale([{ price: 10000, quantity: 10, discountable: true }], { discountRate: 0, vatEnabled: true }, { deductionAmount: 15000, deductionTaxIncluded: true });
  assert.equal(totals.beforeDeductionTotal, 110000);
  assert.equal(totals.beforeDeductionSupply, 100000);
  assert.equal(totals.deduction, 15000);
  assert.equal(totals.deductionTaxIncluded, true);
  assert.equal(totals.supply, 85000);
  assert.equal(totals.vat, 8500);
  assert.equal(totals.total, 93500);
}

{
  const totals = calculateSale([{ price: 10000, quantity: 10, discountable: true }], { discountRate: 10, vatEnabled: true }, { deductionAmount: 15000, deductionTaxIncluded: false });
  assert.equal(totals.subtotal, 100000);
  assert.equal(totals.discount, 8500);
  assert.equal(totals.beforeDeductionSupply, 90000);
  assert.equal(totals.deduction, 15000);
  assert.equal(totals.supply, 76500);
  assert.equal(totals.vat, 7650);
  assert.equal(totals.total, 84150);
}

{
  const totals = calculateSale([{ price: 500000, quantity: 1, discountable: true }], { discountRate: 0, vatEnabled: false }, { deductionAmount: 10000 });
  assert.equal(totals.deduction, 10000);
  assert.equal(totals.discount, 0);
  assert.equal(totals.supply, 490000);
  assert.equal(totals.total, 490000);
}

{
  const totals = calculateSale([{ price: 1000, quantity: 2, discountable: true }], { discountRate: 0, vatEnabled: false }, { deductionAmount: 5000, deductionTaxIncluded: false });
  assert.equal(totals.deduction, 2000);
  assert.equal(totals.total, 0);
}

{
  const totals = calculateSale([{ price: 1000, quantity: 100, discountable: true }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 100000);
}

{
  const totals = calculateSale([{ price: 1000, quantity: 100, discountable: false }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 100000);
}

{
  const totals = calculateSale([{ price: 10000, quantity: 50, discountable: false }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 25000);
  assert.equal(totals.total, 475000);
}

{
  const totals = calculateSale([{ price: 10000, quantity: 100, discountable: false }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 100000);
  assert.equal(totals.total, 900000);
}

{
  const totals = calculateSale([
    { price: 10000, quantity: 100, discountable: false },
    { price: 10000, quantity: 100, discountable: true }
  ], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 200000);
  assert.equal(totals.total, 1800000);
}

{
  const totals = calculateSale([{ price: 10000, quantity: 100, discountable: false }], { discountRate: 10, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 1000000);
}

{
  const totals = calculateSale([{ categoryId: "cat_no_discount", price: 25000, quantity: 20 }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 25000);
  assert.equal(totals.total, 475000);
}

{
  const totals = calculateSale([{ price: 10000, quantity: 50, discountable: true }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 25000);
  assert.equal(totals.total, 475000);
}

{
  const totals = calculateSale([{ price: 10000, originalPrice: 12000, quantity: 50, discountable: false }], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 100000);
  assert.equal(totals.total, 500000);
}

{
  const totals = calculateSale([{ price: 9000, originalPrice: 10000, quantity: 10, discountable: false }], { discountRate: 10, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 100000);
}

{
  const totals = calculateSale([{ price: 9000, originalPrice: 10000, quantity: 10, discountable: true }], { discountRate: 10, vatEnabled: false });
  assert.equal(totals.discount, 10000);
  assert.equal(totals.total, 90000);
}

{
  const totals = calculateSale([{ price: 10000, quantity: 100, discountable: true }], { discountRate: 0, vatEnabled: true, offshore: true });
  assert.equal(totals.discount, 0);
  assert.equal(totals.vat, 0);
  assert.equal(totals.total, 1000000);
}

{
  const totals = calculateSale([
    { name: "product", price: 499000, quantity: 1, discountable: true },
    { name: "\uBC30\uC1A1", categoryId: "cat_no_discount", price: 3500, quantity: 1, discountable: false }
  ], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 502500);
}

{
  const totals = calculateSale([
    { name: "product", price: 500000, quantity: 1, discountable: true },
    { name: "\uBC30\uC1A1", categoryId: "cat_no_discount", price: 3500, quantity: 1, discountable: false }
  ], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 25000);
  assert.equal(totals.total, 478500);
}

{
  const totals = calculateSale([
    { name: "product", price: 1000000, quantity: 1, discountable: true },
    { name: "\uBC30\uC1A1(\uC591\uC591)", categoryId: "cat_no_discount", price: 1000, quantity: 1, discountable: false }
  ], { discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 100000);
  assert.equal(totals.total, 901000);
}

{
  const totals = calculateSale([
    { name: "product", price: 500000, quantity: 1, discountable: true },
    { name: "\uBC30\uC1A1", categoryId: "cat_no_discount", price: 3500, quantity: 1, discountable: false }
  ], { discountRate: 10, vatEnabled: false });
  assert.equal(totals.discount, 50000);
  assert.equal(totals.total, 453500);
}

{
  const totals = calculateSale([
    { name: "product", price: 1000000, quantity: 1, discountable: true },
    { name: "\uBC30\uC1A1", categoryId: "cat_no_discount", price: 3500, quantity: 1, discountable: false }
  ], { discountRate: 0, vatEnabled: true, offshore: true });
  assert.equal(totals.discount, 0);
  assert.equal(totals.vat, 0);
  assert.equal(totals.total, 1003500);
}

{
  const totals = calculateSale([
    { name: "product", price: 1000000, quantity: 1, discountable: true }
  ], { discountRate: 0, vatEnabled: true, offshore: false });
  assert.equal(totals.discount, 100000);
  assert.equal(totals.vat, 90000);
  assert.equal(totals.total, 990000);
}

{
  const totals = calculateSale([
    { name: "product", price: 1000000, quantity: 1, discountable: true }
  ], { name: "\uB0A8\uB3C4\uB9C8\uCF13", discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 1000000);
}

{
  const totals = calculateSale([
    { name: "product", price: 500000, quantity: 1, discountable: true }
  ], { name: "(\uAD11\uC8FC) \uB0A8\uB3C4\uB9C8\uCF13", discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 500000);
}

{
  const totals = calculateSale([
    { name: "product", price: 1000000, quantity: 1, discountable: true }
  ], { name: "\uB0A8\uB3C4\uB9C8\uCF13 - \uC11C\uC6B8", discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 1000000);
}

{
  const totals = calculateSale([
    { name: "product", price: 500000, quantity: 1, discountable: true }
  ], { name: "\uB0A8\uB3C4 \uB9C8\uCF13", discountRate: 0, vatEnabled: false });
  assert.equal(totals.discount, 0);
  assert.equal(totals.total, 500000);
}

console.log("calculation tests passed");
