import {
  annotateBuyPoint,
  BUY_POINT_TYPES,
} from "../../shared/buy-point-type.js";

// 只构造能由当日 EOD 及昨日数据确认的两种买点，不补造缺失行情。
export function buildEodCandidates({
  previous = [],
  eodRows = new Map(),
  ma5ByCode = new Map(),
  existingCodes = new Set(),
  stockInfoByCode = new Map(),
  firstNegMinPrevHeight,
}) {
  const prevByCode = new Map(previous.map((row) => [row.code, row]));
  const candidates = [];
  for (const [code, eod] of eodRows) {
    if (!/^(?:00|30|60)\d{4}$/.test(code) || existingCodes.has(code)) continue;
    const prev = prevByCode.get(code);
    const info = stockInfoByCode.get(code);
    const name = prev?.name || info?.name;
    const sector = prev?.sector || info?.industryName;
    if (!name || /ST|退/.test(name) || !sector || !(eod.close > 0)) continue;
    const row = {
      code,
      name,
      sector,
      price: eod.close,
      open: eod.open,
      close: eod.close,
      high: eod.high,
      change: eod.change,
      amount: null,
      floatCap: null,
      seal: null,
      turnover: null,
      first: null,
      last: null,
      breaks: null,
      height: 0,
      limitUpReason: null,
      themes: [],
      maxSealMoney: null,
      isSt: false,
      isNew: false,
      boardLimit: eod.limitUpPct,
    };
    const yesterday = {
      change: prev?.change ?? eod.prevChange,
      open: prev?.open ?? eod.prevOpen,
      close: prev?.close ?? prev?.price ?? eod.prevClose,
      breaks: prev?.breaks ?? eod.prevBreaks,
      height: prev?.height ?? null,
    };
    const { buyPoint } = annotateBuyPoint(
      { ...row, ma5: ma5ByCode.get(code) ?? null },
      yesterday,
      { firstNegMinPrevHeight },
    );
    if (
      buyPoint.labels.some((type) =>
        [
          BUY_POINT_TYPES.FIRST_NEG_DIP,
          BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP,
        ].includes(type),
      )
    )
      candidates.push(row);
  }
  return candidates;
}
