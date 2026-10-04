import type { Candle } from "../types";

export interface IndicatorPoint { time: number; value: number }
export interface MacdPoint { time: number; macd: number; signal: number; histogram: number }
export interface BollingerPoint { time: number; upper: number; middle: number; lower: number }
export interface StochRsiPoint { time: number; k: number; d: number }

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period <= 0) throw new Error("period must be a positive integer");
}

export function sma(candles: Candle[], period: number): IndicatorPoint[] {
  assertPeriod(period);
  const output: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) output.push({ time: candles[i].time, value: sum / period });
  }
  return output;
}

export function ema(candles: Candle[], period: number): IndicatorPoint[] {
  assertPeriod(period);
  if (candles.length < period) return [];
  const multiplier = 2 / (period + 1);
  let current = candles.slice(0, period).reduce((sum, item) => sum + item.close, 0) / period;
  const output: IndicatorPoint[] = [{ time: candles[period - 1].time, value: current }];
  for (let i = period; i < candles.length; i += 1) {
    current = (candles[i].close - current) * multiplier + current;
    output.push({ time: candles[i].time, value: current });
  }
  return output;
}

export function bollinger(candles: Candle[], period = 20, deviation = 2): BollingerPoint[] {
  assertPeriod(period);
  const output: BollingerPoint[] = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    const slice = candles.slice(i - period + 1, i + 1);
    const middle = slice.reduce((sum, item) => sum + item.close, 0) / period;
    const variance = slice.reduce((sum, item) => sum + (item.close - middle) ** 2, 0) / period;
    const width = Math.sqrt(variance) * deviation;
    output.push({ time: candles[i].time, upper: middle + width, middle, lower: middle - width });
  }
  return output;
}

export function vwap(candles: Candle[]): IndicatorPoint[] {
  let cumulativeVolume = 0;
  let cumulativeValue = 0;
  return candles.map((candle) => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativeValue += typical * candle.volume;
    cumulativeVolume += candle.volume;
    return { time: candle.time, value: cumulativeVolume === 0 ? typical : cumulativeValue / cumulativeVolume };
  });
}

export function rsi(candles: Candle[], period = 14): IndicatorPoint[] {
  assertPeriod(period);
  if (candles.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = candles[i].close - candles[i - 1].close;
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  const output: IndicatorPoint[] = [];
  const value = () => averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  output.push({ time: candles[period].time, value: value() });
  for (let i = period + 1; i < candles.length; i += 1) {
    const delta = candles[i].close - candles[i - 1].close;
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    output.push({ time: candles[i].time, value: value() });
  }
  return output;
}

export function stochRsi(candles: Candle[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): StochRsiPoint[] {
  assertPeriod(rsiPeriod); assertPeriod(stochPeriod); assertPeriod(kSmooth); assertPeriod(dSmooth);
  const rsiValues = rsi(candles, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth + dSmooth - 2) return [];
  const raw: IndicatorPoint[] = [];
  for (let index = stochPeriod - 1; index < rsiValues.length; index += 1) {
    const window = rsiValues.slice(index - stochPeriod + 1, index + 1).map((point) => point.value);
    const low = Math.min(...window); const high = Math.max(...window);
    raw.push({ time: rsiValues[index].time, value: high === low ? 0 : (rsiValues[index].value - low) / (high - low) * 100 });
  }
  const smooth = (values: IndicatorPoint[], period: number) => values.slice(period - 1).map((point, index) => ({
    time: point.time,
    value: values.slice(index, index + period).reduce((sum, item) => sum + item.value, 0) / period
  }));
  const kValues = smooth(raw, kSmooth); const dValues = smooth(kValues, dSmooth);
  const offset = dSmooth - 1;
  return dValues.map((point, index) => ({ time: point.time, k: kValues[index + offset].value, d: point.value }));
}

function emaValues(values: number[], period: number): Array<number | undefined> {
  const output: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (values.length < period) return output;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    current = (values[i] - current) * multiplier + current;
    output[i] = current;
  }
  return output;
}

export function macd(candles: Candle[], fast = 12, slow = 26, signalPeriod = 9): MacdPoint[] {
  assertPeriod(fast); assertPeriod(slow); assertPeriod(signalPeriod);
  const values = candles.map((item) => item.close);
  const fastValues = emaValues(values, fast);
  const slowValues = emaValues(values, slow);
  const macdEntries: Array<{ index: number; value: number }> = [];
  for (let i = 0; i < values.length; i += 1) {
    if (fastValues[i] !== undefined && slowValues[i] !== undefined) {
      macdEntries.push({ index: i, value: fastValues[i]! - slowValues[i]! });
    }
  }
  const signalValues = emaValues(macdEntries.map((entry) => entry.value), signalPeriod);
  return macdEntries.flatMap((entry, i) => signalValues[i] === undefined ? [] : [{
    time: candles[entry.index].time,
    macd: entry.value,
    signal: signalValues[i]!,
    histogram: entry.value - signalValues[i]!
  }]);
}

export function atr(candles: Candle[], period = 14): IndicatorPoint[] {
  assertPeriod(period);
  if (candles.length < period + 1) return [];
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previous = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
  });
  let current = trueRanges.slice(1, period + 1).reduce((sum, value) => sum + value, 0) / period;
  const output: IndicatorPoint[] = [{ time: candles[period].time, value: current }];
  for (let i = period + 1; i < candles.length; i += 1) {
    current = (current * (period - 1) + trueRanges[i]) / period;
    output.push({ time: candles[i].time, value: current });
  }
  return output;
}
