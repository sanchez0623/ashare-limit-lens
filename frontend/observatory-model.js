// Presentation state only. Trading inputs and frozen judgments stay on the server.
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

const paths = {
  "/today": ["overview"],
  "/research/industry": ["sectors", "industry"],
  "/research/themes": ["sectors", "theme"],
  "/research/stocks": ["stocks"],
  "/execution/live": ["paper", "live"],
  "/execution/plan": ["paper", "plan"],
  "/execution/ledger": ["paper", "ledger"],
  "/execution/config": ["paper", "config"],
  "/archive/review": ["review", "review"],
  "/archive/replay": ["review", "replay"],
  "/system/data": ["data"],
  "/system/alerts": ["alerts"],
  "/system/settings": ["settings"],
  "/system/strategies": ["strategies"],
};
const aliases = {
  overview: "/today",
  stocks: "/research/stocks",
  sectors: "/research/industry",
  paper: "/execution/live",
  review: "/archive/review",
  settings: "/system/settings",
  strategies: "/system/strategies",
  alerts: "/system/alerts",
  data: "/system/data",
  "dragon-config-panel": "/execution/config",
  "paper-entry-plan": "/execution/plan",
};
export function validDate(value, max) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value &&
    (!max || value <= max)
  );
}
export function parseRoute(hash = "", maxDate) {
  const [raw, query = ""] = hash.replace(/^#/, "").split("?");
  const [view, tab] = paths[aliases[raw] ?? raw] ?? ["overview"];
  const params = new URLSearchParams(query);
  const height = params.get("height");
  return {
    view,
    tab,
    date: validDate(params.get("date"), maxDate) ? params.get("date") : "",
    industryTaxonomy: ["EM", "SW1", "SW2", "SW3"].includes(
      params.get("taxonomy"),
    )
      ? params.get("taxonomy")
      : "EM",
    height:
      ["first", "relay"].includes(height) || /^[1-9]\d?$/.test(height ?? "")
        ? height
        : "all",
    query: (params.get("q") ?? "").slice(0, 100),
    sector: (params.get("sector") ?? "").slice(0, 100),
    theme: (params.get("theme") ?? "").slice(0, 100),
    sort: ["score", "height", "seal", "first"].includes(params.get("sort"))
      ? params.get("sort")
      : "score",
  };
}
export function routeHash(route) {
  const path =
    Object.entries(paths).find(
      ([, [view, tab]]) => view === route.view && (!tab || tab === route.tab),
    )?.[0] ??
    Object.entries(paths).find(([, [view]]) => view === route.view)?.[0] ??
    "/today";
  const params = new URLSearchParams();
  if (validDate(route.date)) params.set("date", route.date);
  if (route.industryTaxonomy && route.industryTaxonomy !== "EM")
    params.set("taxonomy", route.industryTaxonomy);
  if (route.height && route.height !== "all")
    params.set("height", route.height);
  if (route.query) params.set("q", route.query);
  if (route.sector) params.set("sector", route.sector);
  if (route.theme) params.set("theme", route.theme);
  if (route.sort && route.sort !== "score") params.set("sort", route.sort);
  return `#${path}${params.size ? `?${params}` : ""}`;
}
export function navigationGroup(view) {
  return ["stocks", "sectors"].includes(view) ? "research" : view;
}
export function ladderRows(stocks = []) {
  const counts = new Map();
  for (const stock of stocks) {
    if (
      Number.isInteger(stock.height) &&
      stock.height > 0 &&
      stock.height < 100
    )
      counts.set(stock.height, (counts.get(stock.height) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => b - a)
    .map(([height, count]) => ({ height, count }));
}

const finite = (value, digits = 0) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

export function marketSculptureSvg(
  stocks = [],
  { date = "", interactive = false, prefix = "market" } = {},
) {
  const rows = ladderRows(stocks);
  const max = Math.max(1, ...rows.map((row) => row.count));
  const gap = Math.min(38, 198 / Math.max(1, rows.length));
  const start = 235 - rows.length * gap;
  const blocks = rows
    .map(({ height, count }, index) => {
      const width = (count / max) * 260;
      const x = 222 - width / 2;
      const y = start + index * gap;
      const depth = Math.min(17, gap * 0.48);
      const muted = index % 3;
      const front = ["#a8b294", "#c2b78b", "#a3b6b8"][muted];
      const top = ["#d4d9c6", "#e0d7b6", "#cfdadb"][muted];
      const shape = `<path d="M${x} ${y}l18 -11h${width}l-18 11Z" fill="${top}"/><path d="M${x} ${y}h${width}v${depth}H${x}Z" fill="${front}"/><path d="M${x + width} ${y}l18 -11v${depth}l-18 11Z" fill="#687762" opacity=".7"/><text x="${x - 12}" y="${y + depth * 0.7}" text-anchor="end" fill="#4c594b" font-size="12">${height === 1 ? "首板" : `${height} 板`}</text><text x="${x + width + 28}" y="${y + depth * 0.7}" fill="#4c594b" font-size="12">${count} 家</text>`;
      return interactive
        ? `<a href="${escapeHtml(routeHash({ view: "stocks", height: String(height), date }))}" data-ladder-height="${height}" aria-label="查看${height}板的${count}只个股"><title>${height} 板 · ${count} 家，点击查看个股</title>${shape}</a>`
        : `<g>${shape}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 300" class="market-art" role="${interactive ? "group" : "img"}" aria-label="${escapeHtml(date)}连板结构，${rows.length ? rows.map((r) => `${r.height}板${r.count}家`).join("，") : "暂无可用连板样本"}"><defs><radialGradient id="${prefix}-light"><stop stop-color="#d9cfad" stop-opacity=".4"/><stop offset="1" stop-color="#f4f1e9" stop-opacity="0"/></radialGradient></defs><circle cx="286" cy="103" r="106" fill="url(#${prefix}-light)"/><circle cx="324" cy="65" r="26" fill="#c2ac70" opacity=".7"/><path d="M51 261h359M76 266h303" stroke="#8b967e" stroke-width="1" opacity=".35"/><ellipse cx="230" cy="249" rx="132" ry="9" fill="#64705b" opacity=".07"/><g font-family="Segoe UI,Microsoft YaHei,sans-serif">${blocks || '<text x="230" y="172" text-anchor="middle" fill="#66715f" font-size="14">等待有效行情，展开市场结构</text>'}</g><path d="M87 72v12m-6-6h12M372 211v9m-4-4h8" stroke="#a48d5d" stroke-width="1"/><circle cx="386" cy="115" r="3" fill="#ad634c"/><text x="231" y="290" text-anchor="middle" font-family="Georgia,serif" fill="#69705f" font-size="8" letter-spacing="3">ONE DAY · ONE STRUCTURE</text></svg>`;
}

export function marketPrintSvg(payload) {
  if (
    !payload?.archived ||
    payload.demo ||
    !validDate(payload.date) ||
    !payload.analysis
  )
    return null;
  const a = payload.analysis;
  const metrics = [
    ["涨停家数", finite(a.count), "家"],
    ["封板率", finite(a.sealRate, 1), "%"],
    ["最高连板", finite(a.height), "板"],
    ["情绪强度", finite(a.emotion), "/100"],
  ];
  const sculpture = marketSculptureSvg(a.stocks, {
    date: payload.date,
    prefix: "print",
  })
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "");
  const sectors = (a.sectors ?? []).slice(0, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500" role="img" aria-label="${escapeHtml(payload.date)}市场切片"><rect width="1200" height="1500" fill="#f4f1e9"/><rect x="36" y="36" width="1128" height="1428" fill="none" stroke="#d6d3c5"/><g fill="#344336" font-family="Microsoft YaHei,PingFang SC,sans-serif"><text x="86" y="115" font-size="24" letter-spacing="4">涨停研究台</text><text x="1110" y="115" font-size="15" text-anchor="end" letter-spacing="3">THE MARKET OBSERVATORY</text><path d="M86 150h1028" stroke="#d6d3c5"/><text x="600" y="230" text-anchor="middle" font-size="15" letter-spacing="5">A FIELD NOTE TO KEEP</text><text x="600" y="327" text-anchor="middle" font-family="SimSun,serif" font-size="65">市场，自有形状。</text><text x="600" y="382" text-anchor="middle" font-size="22" letter-spacing="5">${escapeHtml(payload.date.replaceAll("-", " . "))}</text></g><g transform="translate(117 420) scale(2.1)">${sculpture}</g><path d="M86 1090h1028" stroke="#d6d3c5"/><g fill="#344336" font-family="Microsoft YaHei,PingFang SC,sans-serif">${metrics.map(([label, value, unit], i) => `<g transform="translate(${108 + i * 276} 1140)"><text font-size="18" fill="#626b5c">${label}</text><text y="65" font-size="43">${value}<tspan font-size="16" dx="7">${unit}</tspan></text></g>`).join("")}<text x="86" y="1300" font-size="18">主线板块 / ${sectors.length ? sectors.map((s) => escapeHtml(s.name)).join(" · ") : "暂无归档板块"}</text><text x="86" y="1363" font-size="15" fill="#626b5c">${escapeHtml(String(payload.source ?? "盘后归档").slice(0, 65))} · 当日冻结口径</text><text x="86" y="1410" font-size="15" fill="#626b5c">观察结构，保留依据，让判断接受时间检验。</text><text x="1114" y="1410" text-anchor="end" font-size="12" letter-spacing="2">LIMIT LENS / ARCHIVE</text></g></svg>`;
}
