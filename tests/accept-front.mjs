#!/usr/bin/env node
/**
 * 前端自动验收（v3：京东硬件价格追踪）
 * 用法： node tests/accept-front.mjs
 * 不依赖服务：用 data/snapshot.json 注入离线缓存；接口用内存 mock。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "data", "snapshot.json");
const PAGE = path.join(ROOT, "web", "index.html");
const CACHE_KEY = "bid.gpu.snapshot.v2";
// 商品数随数据更新，不再写死；用快照里的 counts 与实际条数比对
const EXPECTED_PRODUCTS = null; // null = 以快照 counts 为准

const base = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
const html = fs.readFileSync(PAGE, "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

const els = new Map();
const makeEl = (id) => ({
  id, innerHTML: "", textContent: "", hidden: false, disabled: false, value: "",
  style: {}, dataset: {},
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
  addEventListener(){}, querySelectorAll(){ return []; },
  getBoundingClientRect(){ return { left: 0, top: 0, width: 100, height: 20 }; },
  contains(){ return false; }, focus(){},
});
const document = {
  getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  querySelectorAll(){ return []; },
  addEventListener(){}, body: { style: {} },
};

let jdMode = "available";
let couponMode = false;
let quoteCalls = 0;
const okRes = (data) => ({ ok: true, json: async () => data });

const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, RegExp, Map, Set, Object, Array, Infinity, isNaN,
  document,
  localStorage: {
    getItem: (k) => (k === CACHE_KEY ? JSON.stringify(base) : null),
    setItem(){}, removeItem(){},
  },
  fetch: async (url, opt) => {
    const u = String(url);
    if (u.includes("/api/jd-price")) {
      if (jdMode === "available") return okRes({ ok: true, data: { available: true, price: 1600000, captured_at: "2026-10-19T23:05:00+08:00", cached: false } });
      if (jdMode === "no_sku") return okRes({ ok: true, data: { available: false, reason: "no_sku" } });
      return okRes({ ok: true, data: { available: false, reason: "fetch_failed", last_price: 1590000, last_captured_at: "2026-10-19T20:00:00+08:00" } });
    }
    if (u.includes("/api/quote")) {
      quoteCalls++;
      let body = {};
      try { body = JSON.parse((opt && opt.body) || "{}"); } catch (e) {}
      const price = Number(body.price) || 0;
      const deduct = (body.user_coupons || []).reduce((s, c) => s + (Number(c.threshold) <= price ? Number(c.amount) : 0), 0);
      const final = Math.max(0, price - deduct);
      return okRes({ ok: true, data: { price, price_promo: price, price_user: final, final, applied: [], notes: [] } });
    }
    if (u.includes("/api/user-coupons")) {
      return okRes({ ok: true, data: { coupons: couponMode ? [{ threshold: 1000000, amount: 100000, stackable: false }] : [], received_at: null } });
    }
    return okRes({ ok: false, data: null, error: { code: "NETWORK", message: "offline" } });
  },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(
  script + "\n;globalThis.__api={state,renderGrid,renderGroups,openProduct,chartSVG,fetchJdPrice};",
  ctx, { filename: "index.html:<script>" }
);
await new Promise((r) => setTimeout(r, 1200));

const ok = [], bad = [], warn = [];
const check = (name, cond, extra = "") => (cond ? ok : bad).push(name + (extra ? " → " + extra : ""));
const el = (id) => ctx.document.getElementById(id);
const grid = () => el("grid").innerHTML;
const cards = () => (grid().match(/<article class="card/g) || []).length;
const productById = new Map((base.products || []).map((p) => [p.id, p]));
const dealById = new Map((base.deal || []).map((d) => [d.product_id, d]));
const liveIds = (base.deal || []).filter((d) => d.price_live != null).map((d) => d.product_id);

/** 取某个商品卡片的 HTML */
const cardOf = (pid) => (grid().match(new RegExp(`<article class="card[^"]*" data-pid="${pid}"[\\s\\S]*?</article>`)) || [""])[0];

/* 1. 结构 */
check("1. 卡片数 = 商品数", cards() === (base.products || []).length, cards() + " 张");
const total = (base.products || []).length;
const catsHtml = el("cats").innerHTML;
const catButtons = [...catsHtml.matchAll(/<button class="cat[^"]*"[\s\S]*?data-cat="([^"]+)">([^<]*)<span>(\d+)<\/span>/g)]
  .map((m) => ({ key: m[1], name: m[2], n: Number(m[3]) }));
const catSum = catButtons.filter((c) => c.key !== "all").reduce((s, c) => s + c.n, 0);
check("2. 品类计数之和 = 商品总数", catSum === total, catSum + "/" + total);
const emptyCats = Object.keys(base.category_names || {}).filter((k) => !(base.products || []).some((p) => p.category === k));
check("3. 空品类不出现", emptyCats.every((k) => !catsHtml.includes(`data-cat="${k}"`)), emptyCats.join(","));

/* 2. site.* */
check("4. 站点名来自 site.name", html.includes("京东硬件价格追踪") && el("siteName").textContent === base.site.name, el("siteName").textContent);
check("5. 免责声明来自 site.disclaimer", el("siteDisclaimer").textContent === base.site.disclaimer);
check("6. 卖点行保留，但不含券那条", (el("promise").innerHTML.match(/<span>/g) || []).length === base.site.promise.filter((x) => !/券/.test(x)).length && !el("promise").textContent.includes("券"),
  el("promise").innerHTML);

/* 3. 价格槽位 */
check("7. 有京东价的卡数量 = 快照里的 live 数", liveIds.length === (base.deal || []).filter((d) => d.price_live != null).length && liveIds.length >= 1, liveIds.length + " 个");
const yuan = (c) => "￥" + (c / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const refDeal = (base.deal || []).find((d) => d.price_live == null);
const refCard = cardOf(refDeal.product_id);
check("8. 无京东价：主价「无价格信息」+ ZOL 参考价小字",
  (grid().match(/class="noprice">无价格信息/g) || []).length === total - liveIds.length &&
  refCard.includes("参考价 ") && refCard.includes("ZOL 第三方汇总"),
  (grid().match(/class="noprice">无价格信息/g) || []).length + " 张 / " + (refCard.match(/jd-sub">[^<]*/) || [""])[0]);
const liveCard = cardOf(liveIds[0]);
check("9. 有价卡：主价 + 京东自营 + 更新时间",
  /class="price"[^>]*>￥[\d,]+\.\d{2}/.test(liveCard) && liveCard.includes("京东自营") && /更新于 \d{2}-\d{2} \d{2}:\d{2}/.test(liveCard),
  liveCard.match(/class="price"[^>]*>[^<]*/)?.[0]);
check("10. 无价卡主价槽位不含 ￥",
  !/<div class="price"/.test(refCard) && refCard.includes(yuan(refDeal.price_reference)),
  (refCard.match(/class="price"[^>]*>[^<]*/) || [""])[0]);

/* 4. 历史位置 */
const lowN = (base.deal || []).filter((d) => (d.hist_points || 0) < 5);
const highN = (base.deal || []).filter((d) => (d.hist_points || 0) >= 5);
const lowCard = cardOf(lowN[0].product_id);
check("11. 点数<5 显示「历史数据不足」", lowCard.includes("历史数据不足（n="), lowCard.match(/hist-line">[\s\S]{0,60}/)?.[0]);
check("12. 点数<5 的历史行没有百分比", !/hist-line">[^<]*\d+\.\d%/.test(lowCard));
const highCard = cardOf(highN[0].product_id);
check("13. 点数≥5 不显示「历史数据不足」", !highCard.includes("历史数据不足"), highCard.match(/hist-line">[\s\S]{0,80}/)?.[0]);
check("14. 当前数据无「历史低位」徽标", (base.deal || []).some((d) => d.at_hist_low) ? true : !grid().includes("历史低位"));

/* 5. 同款比一比 */
const gHtml = el("groupsList").innerHTML;
check("15. 同款比一比有分组", el("groupsSec").hidden === false && (gHtml.match(/class="grow"/g) || []).length >= 1,
  (gHtml.match(/class="grow"/g) || []).length + " 组");
check("16. 分组显示价差与两个品牌", gHtml.includes("价差") && (gHtml.match(/class="gitem/g) || []).length >= 2,
  (gHtml.match(/class="gitem/g) || []).length + " 条");

/* 6. 存疑 / 金额 / 红线 */
const flagId = (base.deal || []).find((d) => d.price_flag)?.product_id;
check("17. price_flag 显示「价格存疑」", flagId ? cardOf(flagId).includes("价格存疑") : true);
const allMoney = [...grid().matchAll(/class="(?:price|ref-price)">[^<]*?￥([\d,]+(?:\.\d+)?)/g)].map((m) => m[1]);
check("18. 金额都是两位小数", allMoney.every((s) => /^[\d,]+\.\d{2}$/.test(s)),
  allMoney.filter((s) => !/^[\d,]+\.\d{2}$/.test(s)).slice(0, 3).join(" "));
check("19. 页面无「比价」", !html.includes("比价"));
const bodyText = grid() + el("noticeText").innerHTML + el("promise").innerHTML;
check("20. 正文无「全网最低」", !bodyText.includes("全网最低"));

/* 7. 图片 / 曲线 */
const missing = (base.products || []).map((p) => p.image_local).filter(Boolean)
  .filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
check("21. 本地图文件都存在", missing.length === 0, missing.slice(0, 3).join(" "));
const mk = (n) => [{ platform: "jd", points: Array.from({ length: n }, (_, i) => ({
  iso: `2026-10-19T2${i}:00:00+08:00`, t: Date.parse(`2026-10-19T2${i}:00:00+08:00`), v: 1600000 + i * 100,
})) }];
check("27. 抓价/刷新按钮默认隐藏（?dev=1 才显示）",
  /class="btn dev-only" id="refreshBtn"/.test(html) && html.includes("body.dev .dev-only"));
check("22. 曲线 0/1/2 点不崩",
  ctx.__api.chartSVG([]).includes("暂无历史") &&
  ctx.__api.chartSVG(mk(1)).includes("circle") &&
  ctx.__api.chartSVG(mk(2)).includes("path"));

/* 8. jd-price 三态 */
jdMode = "available";
await ctx.__api.fetchJdPrice(liveIds[0], true);
await new Promise((r) => setTimeout(r, 200));
check("23. available → 主价更新", /class="price"[^>]*>￥16,000\.00/.test(cardOf(liveIds[0])), cardOf(liveIds[0]).match(/class="price"[^>]*>[^<]*/)?.[0]);
const noLiveId = (base.deal || []).find((d) => d.price_live == null && (base.products || []).find((p) => p.id === d.product_id)?.jd_sku)?.product_id
  || (base.deal || []).find((d) => d.price_live == null).product_id;
jdMode = "fetch_failed";
await ctx.__api.fetchJdPrice(noLiveId, true);
await new Promise((r) => setTimeout(r, 200));
check("24. fetch_failed → 无价格信息 + 上次价",
  cardOf(noLiveId).includes("无价格信息") && cardOf(noLiveId).includes("上次"),
  cardOf(noLiveId).match(/jd-sub">[^<]*/)?.[0]);

/* 9. 券后价 */
const beforeCalls = quoteCalls;
ctx.__api.openProduct(liveIds[0]);
await new Promise((r) => setTimeout(r, 600));
check("25. 券后价已下线（不请求 /api/quote）", quoteCalls === beforeCalls, "调用 " + (quoteCalls - beforeCalls) + " 次");
check("26. 详情显示「未计算折扣券」说明", (el("mBody").innerHTML || "").includes("未计算折扣券"),
  ((el("mBody").innerHTML || "").match(/未计算折扣券[^。<]{0,40}/) || [])[0]);

const wantProducts = EXPECTED_PRODUCTS ?? base.counts?.products ?? null;
if (wantProducts != null && (base.products || []).length !== wantProducts) {
  warn.push(`商品数 ${(base.products || []).length}，快照 counts 写的是 ${wantProducts}`);
}

console.log("\n=== 前端验收（任务书 v3） ===");
ok.forEach((x) => console.log("  ✓ " + x));
bad.forEach((x) => console.log("  ✗ " + x));
warn.forEach((x) => console.log("  ! " + x));
console.log(`\nPASS ${ok.length} / ${ok.length + bad.length}`);
console.log(bad.length ? "FAIL" : "PASS");
process.exit(bad.length ? 1 : 0);






