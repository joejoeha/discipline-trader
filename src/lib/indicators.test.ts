import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import { atr, bollinger, ema, macd, rsi, sma, stochRsi, vwap } from "./indicators";

const candles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
  time: 1_700_000_000 + index * 60,
  open: 99 + index,
  high: 101 + index,
  low: 98 + index,
  close: 100 + index,
  volume: 10 + index
}));

describe("indicators", () => {
  it("calculates SMA and EMA from deterministic values", () => {
    expect(sma(candles, 3)[0].value).toBe(101);
    expect(sma(candles, 3).at(-1)?.value).toBe(138);
    expect(ema(candles, 3)[0].value).toBe(101);
    expect(ema(candles, 3).at(-1)?.value).toBeCloseTo(138, 8);
  });

  it("calculates volatility and momentum series without NaN", () => {
    const all = [
      ...atr(candles, 14).map((point) => point.value),
      ...rsi(candles, 14).map((point) => point.value),
      ...vwap(candles).map((point) => point.value),
      ...bollinger(candles, 20, 2).flatMap((point) => [point.upper, point.middle, point.lower]),
      ...macd(candles).flatMap((point) => [point.macd, point.signal, point.histogram])
    ];
    expect(all.length).toBeGreaterThan(50);
    expect(all.every(Number.isFinite)).toBe(true);
    expect(rsi(candles, 14).every((point) => point.value === 100)).toBe(true);
  });

  it("calculates bounded StochRSI K and D with configurable smoothing", () => {
    const oscillating = Array.from({ length: 120 }, (_, index) => ({
      ...candles[index % candles.length],
      time: 1_700_000_000 + index * 60,
      close: 100 + Math.sin(index / 3) * 8 + index * 0.03,
      open: 100 + Math.sin((index - 1) / 3) * 8 + index * 0.03,
      high: 109 + Math.sin(index / 3) * 8,
      low: 91 + Math.sin(index / 3) * 8
    }));
    const standard = stochRsi(oscillating, 14, 14, 3, 3);
    const faster = stochRsi(oscillating, 7, 7, 2, 2);
    expect(standard.length).toBeGreaterThan(50);
    expect(faster.length).toBeGreaterThan(standard.length);
    expect(standard.flatMap((point) => [point.k, point.d]).every((value) => Number.isFinite(value) && value >= 0 && value <= 100)).toBe(true);
  });
});
