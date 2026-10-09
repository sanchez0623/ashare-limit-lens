export const DEFAULT_INITIAL_CAPITAL = 1_000_000;
export const FEE_FIELDS = Object.freeze([
  {
    key: "commission_rate",
    label: "佣金率",
    unit: "万分之",
    direction: "双边",
  },
  { key: "commission_min", label: "最低佣金", unit: "元", direction: "双边" },
  { key: "stamp_tax", label: "印花税", unit: "万分之", direction: "仅卖出" },
  { key: "handling_fee", label: "经手费", unit: "万分之", direction: "双边" },
  { key: "regulatory_fee", label: "证管费", unit: "万分之", direction: "双边" },
  { key: "transfer_fee", label: "过户费", unit: "万分之", direction: "双边" },
]);
export const DEFAULT_FEES = Object.freeze({
  commission_rate: 0.00005,
  commission_min: 5,
  stamp_tax: 0.0005,
  handling_fee: 0.0000341,
  regulatory_fee: 0.00002,
  transfer_fee: 0.00001,
});
// Explicit compatibility for frozen plans exported before fee customization.
export const LEGACY_FEES = Object.freeze({
  commission_rate: 0.00025,
  commission_min: 5,
  stamp_tax: 0.0005,
  handling_fee: 0,
  regulatory_fee: 0,
  transfer_fee: 0.00001,
});
export function validFees(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== FEE_FIELDS.length) return false;
  return FEE_FIELDS.every(({ key }) => {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
      return false;
    return key === "commission_min"
      ? number <= 10000 &&
          Math.abs(number * 100 - Math.round(number * 100)) < 0.000001
      : number <= 0.01;
  });
}
export function normalizeFees(value) {
  if (!validFees(value))
    throw new Error(
      "费用必须包含六个有效数值：费率为 0–100 万分之，最低佣金为 0–10000 元且精确到分",
    );
  return Object.fromEntries(
    FEE_FIELDS.map(({ key }) => [
      key,
      key === "commission_min"
        ? Math.round(value[key] * 100) / 100
        : Number(value[key].toFixed(9)),
    ]),
  );
}
export function feesForBook(book) {
  return book.feeConfig || LEGACY_FEES;
}
