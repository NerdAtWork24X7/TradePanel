import test from "node:test";
import assert from "node:assert/strict";
import {
  formatExchangePrice,
  roundToExchangePrice,
} from "../src/lib/exchange-price.ts";

const BTC = { price_decimals: 1, price_sig_figs: 5 };
const ETH = { price_decimals: 2, price_sig_figs: 5 };
const PEPE = { price_decimals: 6, price_sig_figs: 5 };

test("rounds to the exchange tick", () => {
  assert.equal(roundToExchangePrice(96.75915071108538, BTC), 96.8);
  assert.equal(roundToExchangePrice(97.2737621818553, ETH), 97.27);
  assert.equal(roundToExchangePrice(0.012345678, PEPE), 0.012346);
});

test("caps price at five significant figures", () => {
  assert.equal(roundToExchangePrice(150.123456789, { price_decimals: 4, price_sig_figs: 5 }), 150.12);
  assert.equal(roundToExchangePrice(96000.123456, BTC), 96000);
});

test("formats without float tails or trailing zeros", () => {
  assert.equal(formatExchangePrice(96.75915071108538, BTC), "96.8");
  assert.equal(formatExchangePrice(96.75915071108538, ETH), "96.76");
  assert.equal(formatExchangePrice(100, ETH), "100");
  assert.equal(formatExchangePrice(0.012345678, PEPE), "0.012346");
  assert.equal(formatExchangePrice(0.1 + 0.2, { price_decimals: 6, price_sig_figs: 5 }), "0.3");
});

test("degenerate precision metadata cannot throw", () => {
  assert.equal(formatExchangePrice(12.3456, { price_decimals: -2, price_sig_figs: 0 }), "10");
  assert.equal(formatExchangePrice(Number.NaN, BTC), "");
});
