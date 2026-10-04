import { describe, expect, it } from "vitest";
import type { RoutingSettings } from "../types";
import { classifyAsset, effectiveFeeProfile } from "./routing";

const routing: RoutingSettings = {
  cryptoExchange: "ourbit",
  stockExchange: "mexc",
  oilExchange: "mexc",
  preciousMetalExchange: "mexc",
  mexcFees: { makerPercent: "0.06", takerPercent: "0.08", source: "configured" },
  ourbitFees: { makerPercent: "0.008", takerPercent: "0.025", source: "configured" },
  warnOnOverride: true,
  updatedAt: 1
};

describe("effective fee routing", () => {
  it.each(["SPCXSTOCK_USDT", "OIL(WTI)_USDT", "GOLD(XAU)_USDT"])("uses zero MEXC trading fees for %s", (symbol) => {
    const profile = effectiveFeeProfile(routing, "mexc", classifyAsset(symbol));
    expect(profile.makerPercent).toBe("0");
    expect(profile.takerPercent).toBe("0");
  });

  it("keeps configured MEXC crypto fees", () => {
    expect(effectiveFeeProfile(routing, "mexc", "crypto").takerPercent).toBe("0.08");
  });

  it("keeps Ourbit fees unchanged", () => {
    expect(effectiveFeeProfile(routing, "ourbit", "crypto").makerPercent).toBe("0.008");
  });
});
