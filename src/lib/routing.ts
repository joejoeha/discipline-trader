import type { AssetClass, ExchangeId, FeeProfile, RoutingSettings } from "../types";

export function classifyAsset(symbol: string): AssetClass {
  const upper = symbol.toUpperCase();
  if (/WTI|BRENT|OIL/.test(upper)) return "oil";
  if (/XAU|XAUT|GOLD|XAG|SILVER|XPT|PLATINUM|XPD|PALLADIUM/.test(upper)) return "precious_metal";
  if (upper.includes("STOCK") || /^(AAPL|AMZN|COIN|GOOGL|HOOD|MCD|META|MSTR|NFLX|NVDA|TSLA)_/.test(upper)) return "stock";
  return "crypto";
}

export function preferredExchange(routing: RoutingSettings, assetClass: AssetClass): ExchangeId {
  if (assetClass === "crypto") return routing.cryptoExchange;
  if (assetClass === "stock") return routing.stockExchange;
  if (assetClass === "oil") return routing.oilExchange;
  return routing.preciousMetalExchange;
}

export function effectiveFeeProfile(routing: RoutingSettings, exchange: ExchangeId, assetClass: AssetClass): FeeProfile {
  const configured = exchange === "mexc" ? routing.mexcFees : routing.ourbitFees;
  if (exchange === "mexc" && assetClass !== "crypto") {
    return {
      makerPercent: "0",
      takerPercent: "0",
      source: "用户指定：MEXC 股票、原油与贵金属合约 0% 交易手续费",
      verifiedAt: configured.verifiedAt
    };
  }
  return configured;
}
