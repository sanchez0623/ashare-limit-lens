export const OBSERVATION_CLASS_LABELS = Object.freeze({
  "relay-leader": "连板龙头型",
  "strong-reversal": "强势反包型",
  "swing-range": "波段震荡型",
  mediocre: "平庸型",
  unclassified: "未分类",
});

export const OBSERVATION_SOURCE_LABELS = Object.freeze({
  "limit-up": "信号日涨停池",
  broken: "信号日炸板池",
  extra: "信号日日线扩展池",
  history: "历史准入补充",
});

// 兼容已冻结说明里的 HHMMSS 整数，仅格式化展示，不改写快照或交易规则。
export function formatObservationBuyPointReason(reason) {
  return String(reason ?? "").replace(
    /(首封时间\s*)(\d{5,6})(?![\d.:])/g,
    (original, label, value) => {
      const time = value.padStart(6, "0");
      const hour = time.slice(0, 2);
      const minute = time.slice(2, 4);
      const second = time.slice(4, 6);
      if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
        return original;
      return `${label}${hour}:${minute}:${second}`;
    },
  );
}
