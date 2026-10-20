// 导出 snapshot.json（给前端），并按设计文档 §6 计算好价
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "data", "snapshot.json");

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA query_only=ON");

let products;
try {
  products = db.prepare(`SELECT * FROM product WHERE active=1 ORDER BY id`).all();
} catch {
  products = db.prepare(`SELECT * FROM product ORDER BY id`).all(); // 老库没 active 列时兼容
}
const activeIds = new Set(products.map((p) => p.id));

// —— 展示名清洗：去掉电商堆词，只留「品牌 + 芯片 + 版本」——
// 原始 model 保留不动（搜索/匹配要用），另给一个 display_name 供页面展示
const MARKETING = /(AI\s*学习|智能学习|OpenClaw|直播|电竞|游戏|设计|独立显卡|台式机|电脑显卡|显卡|全新|正品|原装|包邮|顺丰|秒杀|优惠|旗舰店|官方旗舰|直营|套装|组合|超值|热卖|爆款)/gi;
const cleanName = (p) => {
  const raw = String(p.model || "");
  if (!raw.trim()) return raw;
  // 1) 取芯片段：RTX/GTX/RX/ARC + 数字 + 后缀 + 容量
  const chip = raw.match(/((?:RTX|GTX|RX|ARC)\s?\d{3,4}\s?(?:Ti|SUPER|XT)?\s?(?:\d{1,2}\s?GB)?)/i);
  const brand = String(p.brand || "").trim();
  if (!chip) {
    // 没有芯片段的（内存/电源/键盘等），只做去营销词 + 截断
    const t = raw.replace(MARKETING, " ").replace(/\s+/g, " ").trim();
    return (brand && !t.toLowerCase().startsWith(brand.toLowerCase()) ? brand + " " : "") + t.slice(0, 34);
  }
  const chipText = chip[1].replace(/\s+/g, " ").trim();
  // 2) 芯片段之后的中文版本名（如 曜夜/魔龙/大地之神/雪鹰），最多 6 字
  const after0 = raw.slice(raw.indexOf(chip[1]) + chip[1].length);
  // 芯片段后面紧跟的容量（如 -12GB）先去掉，再取版本名
  const after = after0.replace(/^[\s\-]*\d{1,2}\s?GB/i, "")
    .replace(MARKETING, " ")
    .replace(/[（(].*?[)）]/g, " ")
    .replace(/\b(OC|GAMING|GC|DLSS|GDDR\d|HDMI|DP|RGB|版|款)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const version = (after.match(/[\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9·\-]{0,7}/) || [""])[0];
  const name = [brand, chipText, version].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return name.length > 34 ? name.slice(0, 34) : name;
};
for (const p of products) p.display_name = cleanName(p);

// —— 展示层去重：同品类 + 同品牌 + 同展示名，只留一个（京东 SKU 优先，其次 id 小）——
{
  const normKey = (p) => [p.category, String(p.brand || "").toUpperCase(), String(p.display_name || "").replace(/\s+/g, "").toUpperCase()].join("|");
  const best = new Map();
  for (const p of products) {
    const k = normKey(p);
    const cur = best.get(k);
    if (!cur) best.set(k, p);
    else if ((p.jd_sku ? 1 : 0) > (cur.jd_sku ? 1 : 0) || ((p.jd_sku ? 1 : 0) === (cur.jd_sku ? 1 : 0) && p.id < cur.id)) best.set(k, p);
  }
  const keep = new Set([...best.values()]);
  const dropped = products.filter((p) => !keep.has(p));
  if (dropped.length) {
    console.log(`  展示层去重：隐藏 ${dropped.length} 个重复商品（例 #${dropped[0].id} ${dropped[0].display_name}）`);
    for (let i = products.length - 1; i >= 0; i--) if (!keep.has(products[i])) products.splice(i, 1);
  }
}

// 每个 product+platform 的最新一条
const latest = db
  .prepare(
    `SELECT l.* FROM listing l
     JOIN (SELECT product_id, platform, MAX(captured_at) mx FROM listing GROUP BY product_id, platform) m
       ON l.product_id=m.product_id AND l.platform=m.platform AND l.captured_at=m.mx
     ORDER BY l.product_id, l.platform`
  )
  .all()
  .filter((r) => activeIds.has(r.product_id));

const histRows = db
  .prepare(`SELECT product_id, platform, price, captured_at FROM price_history ORDER BY captured_at`)
  .all()
  .filter((r) => activeIds.has(r.product_id));

// 按 product+platform 归并历史点（同一时间戳只留一条，避免图上重复点）
const histMap = new Map();
for (const r of histRows) {
  const k = `${r.product_id}|${r.platform}`;
  if (!histMap.has(k)) histMap.set(k, { product_id: r.product_id, platform: r.platform, points: [] });
  const pts = histMap.get(k).points;
  if (pts.length && String(pts[pts.length - 1][0]).slice(0, 16) === String(r.captured_at).slice(0, 16)) continue;
  pts.push([r.captured_at, r.price]);
}
const history = [...histMap.values()];

const failures = db
  .prepare(`SELECT status, ok_count, fail_count, anomaly_count, started_at FROM collect_run ORDER BY id DESC LIMIT 5`)
  .all();

// —— 好价判定（设计文档 §6）——
const deal = [];
for (const p of products) {
  const rows = latest.filter((l) => l.product_id === p.id && l.price != null);
  if (!rows.length) continue;

  // 只有"可信报价"(confidence=ok，即登录态实时抓的官方价)才参与最低价断言；
  // ZOL 参考价可能过期，只能当参考/校验，不能赢"全网最低"。
  const okRows = rows.filter((r) => r.confidence === "ok");
  const usable = (okRows.length ? okRows : rows).slice().sort((a, b) => a.price - b.price);
  const pNow = usable[0].price;
  const platformCount = new Set(usable.map((r) => r.platform)).size;
  const secondMin = usable.length > 1 ? usable[1].price : null;
  const priceSource = usable[0].platform === "jd" ? "jd_live" : "zol_reference";

  // —— 展示口径（2026-10-19 产品方向调整）——
  // 主价 = 京东实时可购买价；ZOL 只做不显眼的参考价；没有京东价就不冒充有
  const live = rows.filter((r) => r.platform === "jd" && r.seller_type === "official" && r.price != null)
    .sort((a, b) => a.price - b.price);
  const refs = rows.filter((r) => r.platform === "zol" && r.price != null)
    .sort((a, b) => a.price - b.price);
  const priceLive = live.length ? live[0].price : null;
  const priceReference = refs.length ? refs[0].price : null;
  const priceRole = priceLive != null ? "live" : priceReference != null ? "reference_only" : null;

  // 历史均值必须"同平台同口径"：拿当前价所在平台自己的历史，不能跨平台混算
  const bestPlatform = usable[0].platform;
  const pts = histRows.filter((r) => r.product_id === p.id && r.platform === bestPlatform);
  const avg = pts.length >= 3 ? Math.round(pts.reduce((s, r) => s + r.price, 0) / pts.length) : null;

  // —— 历史位置指标（A+C 里的"历史维度"）——
  const prices = pts.map((r) => r.price).filter((x) => x != null);
  const histMin = prices.length ? Math.min(...prices) : null;
  const histMax = prices.length ? Math.max(...prices) : null;
  const histMedian = prices.length
    ? (() => { const a = prices.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); })()
    : null;
  const refNow = priceLive != null ? priceLive : pNow;
  const vsAvgPct = avg ? Number((((refNow - avg) / avg) * 100).toFixed(1)) : null;
  const vsMinPct = histMin ? Number((((refNow - histMin) / histMin) * 100).toFixed(1)) : null;
  // 只有点数够、且历史上真的有过波动，才有资格说"历史低位"
  const hasRange = histMin != null && histMax != null && histMax > histMin * 1.02;
  const atHistLow = prices.length >= 5 && hasRange && refNow <= histMin * 1.01;

  const reasons = [];
  if (p.msrp && p.msrp > 0 && (p.msrp - pNow) / p.msrp >= 0.1) {
    reasons.push(`低于指导价 ${(((p.msrp - pNow) / p.msrp) * 100).toFixed(1)}%`);
  }
  if (avg && pNow <= avg * 0.92) reasons.push(`低于近期均价 ${(((avg - pNow) / avg) * 100).toFixed(1)}%`);
  // 只有两个以上"可信报价"平台时才敢说全网最低
  if (okRows.length >= 2 && platformCount >= 2 && secondMin != null && pNow < secondMin) {
    reasons.push("全网最低（覆盖平台内）");
  }

  // —— 走势数据（C 方案：只用我们自己的历史，京东优先，没有就用 ZOL）——
  // 同一时间戳只保留一条（重复抓取会产生重复点）
  const seenT = new Set();
  const trend = pts
    .filter((r) => r.price != null && r.captured_at)
    .sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)))
    .filter((r) => { const mk = String(r.captured_at).slice(0, 16); if (seenT.has(mk)) return false; seenT.add(mk); return true; })
    .slice(-40)
    .map((r) => ({ t: r.captured_at, p: r.price }));

  const confidence = okRows.length ? "ok" : "partial";
  deal.push({
    product_id: p.id,
    price: pNow,
    // —— 展示口径：主价必须是可购买价（京东实时），ZOL 只做参考 ——
    price_live: priceLive,            // 京东自营实时价（分）；null = 暂无实时价
    price_reference: priceReference,  // ZOL 参考价（分），可能滞后
    price_role: priceRole,            // "live" | "reference_only" | null
    market_min: pNow,
    price_source: priceSource,
    // —— 历史位置（A+C）——
    hist_min: histMin,
    hist_max: histMax,
    hist_median: histMedian,
    vs_avg_pct: vsAvgPct,        // 现价相对历史均价（%），负数=更便宜
    vs_min_pct: vsMinPct,        // 现价相对历史最低（%），0=就是最低
    at_hist_low: atHistLow,      // 是否处于历史低位（≥5 个点才判定）
    hist_points: prices.length,
    // —— 走势（自己的历史；京东优先，无京东则 ZOL）——
    trend_platform: bestPlatform,
    trend_points: trend.length,
    trend,
    msrp: p.msrp,
    discount_vs_msrp: p.msrp ? Number(((p.msrp - pNow) / p.msrp).toFixed(4)) : null,
    hist_avg: avg,
    points: pts.length,
    platform_count: platformCount,
    confidence,
    is_good_deal: reasons.length > 0,
    reasons,
  });
}

// —— 同型号横向对比（A+C 里的"横向筛选"）——
// 把同型号不同品牌/不同版本聚成一组，前端可做"同款比一比"
const modelKey = (p) => {
  const t = String(p.model || "").toUpperCase();
  const nums = [...t.matchAll(/\d{4}/g)].map((m) => m[0]);
  const words = ["SUPER", "TI", "XT"].filter((w) => new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`).test(t));
  const st = (t.match(/(\d{1,3})\s*GB/) || [])[0];
  if (!nums.length) return null;
  return [p.category, nums.slice(0, 2).join("-"), words.join("-"), st ? st.replace(/\s/g, "") : ""].filter(Boolean).join("|");
};
const groupMap = new Map();
for (const d of deal) {
  const p = products.find((x) => x.id === d.product_id);
  if (!p) continue;
  const k = modelKey(p);
  if (!k) continue;
  if (!groupMap.has(k)) groupMap.set(k, []);
  groupMap.get(k).push({
    product_id: d.product_id,
    brand: p.brand || "",
    model: p.model,
    display_name: p.display_name || p.model,
    price_live: d.price_live,
    price_reference: d.price_reference,
    price_role: d.price_role,
    is_good_deal: d.is_good_deal,
  });
}
const modelGroups = [...groupMap.entries()]
  .filter(([, items]) => items.length >= 2)
  .map(([key, items]) => {
    const withLive = items.filter((x) => x.price_live != null);
    const prices = withLive.map((x) => x.price_live);
    return {
      key,
      label: (items[0].display_name || items[0].model || "").replace(/^[^A-Za-z0-9\u4e00-\u9fa5]+/, "").slice(0, 30),
      count: items.length,
      live_count: withLive.length,
      min_live: prices.length ? Math.min(...prices) : null,
      max_live: prices.length ? Math.max(...prices) : null,
      spread: prices.length >= 2 ? Math.max(...prices) - Math.min(...prices) : null,
      items: items.sort((a, b) => (a.price_live ?? 1e15) - (b.price_live ?? 1e15)),
    };
  })
  .sort((a, b) => (b.live_count - a.live_count) || (b.count - a.count));

// —— 第三方参考源（B站显卡日报）：独立展示，不参与我们的最低价计算 ——
let reference = null;
try {
  const rows = db.prepare(`SELECT * FROM bili_report ORDER BY date, model`).all();
  if (rows.length) {
    const byModel = {};
    for (const r of rows) {
      byModel[r.model] = byModel[r.model] || { model: r.model, points: [] };
      byModel[r.model].points.push({
        date: r.date, low_hist: r.low_hist, low_day: r.low_day, msrp: r.msrp,
        jd: r.jd, tb: r.tb, pdd: r.pdd, yin: r.yin,
      });
    }
    reference = {
      source: rows[0].source,
      note: "第三方整理数据（UP 主脚本当日凌晨爬取）。仅作参考，不是本平台实测价，不参与最低价计算。",
      platform_names: { jd: "京东自营", tb: "淘宝", pdd: "拼多多", yin: "抖音（据其「某音」前缀推断）" },
      dates: [...new Set(rows.map((r) => r.date))].sort(),
      series: Object.values(byModel),
    };
  }
} catch {
  reference = null; // 没导入参考源时不影响主流程
}

// —— 把参考源的"系列"匹配到我们的具体商品，算出近 7 天趋势（只做叙事，不参与最低价）——
function seriesMatcher(model) {
  const t = String(model).toUpperCase();
  const nums = [...t.matchAll(/\d{3,5}/g)].map((m) => m[0]);
  const words = ["SUPER", "TI", "XT"].filter((w) => new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`).test(t));
  const st = (t.match(/(\d{1,4})\s*(GB|G)\b/) || [])[0];
  return { nums: [...new Set(nums)], words, st: st ? st.replace(/\s/g, "") : null };
}
function matchSeries(productModel, seriesList) {
  const pf = seriesMatcher(productModel);
  let best = null;
  for (const s of seriesList) {
    const mf = seriesMatcher(s.model);
    if (!mf.nums.length || !mf.nums.every((n) => pf.nums.includes(n))) continue;
    if (mf.words.length !== pf.words.length || !mf.words.every((w) => pf.words.includes(w))) continue;
    if (mf.st && pf.st && mf.st !== pf.st) continue;
    best = s; // 后面的匹配更具体时覆盖（列表按日期已排序，这里只取首个满足）
    break;
  }
  return best;
}

const dealOut = [];
for (const d of deal) {
  const p = products.find((x) => x.id === d.product_id);
  let ref = null;
  let priceFlag = null;
  if (reference && reference.series && p) {
    const s = matchSeries(p.model, reference.series);
    if (s && s.points.length >= 2) {
      const first = s.points[0], last = s.points[s.points.length - 1];
      const pct = first.low_day ? Number((((last.low_day - first.low_day) / first.low_day) * 100).toFixed(1)) : null;
      // 与参考源的当日最低价比，偏离超过 40% 就标存疑（例：映众 5080 报 8299，参考 14899）
      if (last.low_day) {
        const dev = (d.price - last.low_day) / last.low_day;
        if (Math.abs(dev) > 0.4) priceFlag = {
          flag: "suspect",
          dev_pct: Number((dev * 100).toFixed(1)),
          why: `与第三方参考当日最低 ￥${(last.low_day / 100).toFixed(0)} 偏离 ${(dev * 100).toFixed(1)}%`,
        };
      }
      ref = {
        ref_model: s.model,
        ref_days: s.points.length,
        ref_low_day_latest: last.low_day,
        ref_jd_latest: last.jd,
        ref_msrp: last.msrp,
        ref_change_pct: pct,
        ref_platform_names: reference.platform_names,
        note: "系列级参考（第三方整理），不等于本商品的实测价",
      };
    }
  }
  const isDeal = d.is_good_deal && !priceFlag;
  dealOut.push({
    ...d,
    // 存疑价不能当“最低价”：price_flag 存在时清空 market_min
    market_min: priceFlag ? null : d.market_min,
    is_good_deal: isDeal,
    reasons: priceFlag ? [...d.reasons, "价格存疑，不参与好价"] : d.reasons,
    price_flag: priceFlag,
    reference_match: ref,
  });
}

// generated_at = 数据的采集时间（最新一条报价的时间）；exported_at = 本次导出的时间。
// 这样"刷新"只有在真的抓到新价格时才会改变 generated_at，前端不会误以为更新了。
const dataAt =
  [...histRows.map((r) => r.captured_at), ...latest.map((r) => r.captured_at)]
    .filter(Boolean)
    .sort()
    .pop() || null;

const CATEGORY_NAMES = {
  vga: "显卡", cpu: "CPU", memory: "内存", power: "电源", case: "机箱",
  keyboard: "键盘", router: "路由器", projector: "投影仪", notebook: "笔记本",
  printer: "打印机", speaker: "音箱", ups: "UPS电源", gamepad: "游戏手柄",
  ultrabook: "超极本", mb: "主板",
};

const snapshot = {
  generated_at: dataAt || nowIso(),
  exported_at: nowIso(),
  // 产品定位（A：重定位叙事，前端直接读这里，别写死文案）
  site: {
    name: "京东硬件价格追踪",
    tagline: "不止告诉你现在多少钱，还告诉你这个价值不值得买",
    positioning: "单平台（京东自营）可购买价 + 历史位置 + 你自己的券后价",
    disclaimer: "价格来自京东自营页面，每 30 分钟采集；参考价来自第三方汇总，可能滞后。不承诺实时性，也不宣称全网最低。",
    promise: ["可购买价（京东自营）", "价格历史位置", "用你自己的券算到手价", "同型号横向对比"],
  },
  category_names: CATEGORY_NAMES,
  counts: { products: products.length, listings: latest.length, history_points: histRows.length },
  products,
  latest,
  history,
  deal: dealOut,
  model_groups: modelGroups,
  reference,
  collect_runs: failures,
};

// 原子写：先写临时文件再 rename，避免并发 GET 读到半个 JSON
const tmp = OUT + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
fs.renameSync(tmp, OUT);
console.log(`已导出 ${path.relative(ROOT, OUT)}`);
console.log(`  products=${products.length} latest=${latest.length} history_points=${histRows.length} deal=${dealOut.length}`);
const withRef = dealOut.filter((d) => d.reference_match);
console.log(`  匹配到参考源的商品: ${withRef.length} 条` + (withRef.length ? `，例: #${withRef[0].product_id} ${withRef[0].reference_match.ref_model} 7天 ${withRef[0].reference_match.ref_change_pct}%` : ""));
const withDeal = dealOut.filter((d) => d.is_good_deal);
console.log(`  判定为好价: ${withDeal.length} 条` + (withDeal.length ? `，例: #${withDeal[0].product_id} ${withDeal[0].reasons.join("/")}` : ""));
db.close();
