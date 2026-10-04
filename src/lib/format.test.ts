import { describe, expect, it } from "vitest";
import { formatSignificant } from "./format";

describe("formatSignificant", () => {
  it("keeps six useful digits without floating-point tails", () => {
    expect(formatSignificant("2472.34270999999927276803458")).toBe("2472.34");
    expect(formatSignificant("0.000024720500000000001")).toBe("0.0000247205");
  });

  it("keeps signs and presents missing values clearly", () => {
    expect(formatSignificant("-0.01392728999999997859514316")).toBe("-0.0139273");
    expect(formatSignificant(null)).toBe("—");
  });
});
