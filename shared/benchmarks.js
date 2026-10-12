// 模拟账户收益曲线可选的基准指数（腾讯行情代码）。
// 交易日历始终以上证指数判定；基准曲线随账户设置切换。
export const DEFAULT_BENCHMARK = "sh000001";
export const BENCHMARK_INDEXES = [
  { code: "sh000001", name: "上证指数" },
  { code: "sz399001", name: "深证成指" },
  { code: "sh000300", name: "沪深300" },
  { code: "sh000905", name: "中证500" },
  { code: "sh000852", name: "中证1000" },
  { code: "sz399006", name: "创业板指" },
  { code: "sh000688", name: "科创50" },
];
export const BENCHMARK_CODES = new Set(
  BENCHMARK_INDEXES.map((row) => row.code),
);
export const benchmarkName = (code) =>
  BENCHMARK_INDEXES.find((row) => row.code === code)?.name || "上证指数";
