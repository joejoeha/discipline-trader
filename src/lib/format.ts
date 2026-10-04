/**
 * Formats an exchange decimal for display without exposing binary floating-point
 * noise. Six significant digits retain useful precision for both large prices
 * and small contract quantities (for example 2472.05 and 0.0000247205).
 */
export function formatSignificant(value: string | number | null | undefined, digits = 6): string {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number === 0) return "0";

  const rounded = Number(number.toPrecision(digits));
  const exponent = Math.floor(Math.log10(Math.abs(rounded)));
  const fractionDigits = Math.max(0, digits - exponent - 1);

  // Intl supports up to 20 decimal places. Below that threshold a scientific
  // representation is clearer than silently dropping meaningful precision.
  if (fractionDigits > 20) return rounded.toExponential(digits - 1).replace(/\.?(0+)(e)/, "$2");
  return rounded.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: fractionDigits });
}
