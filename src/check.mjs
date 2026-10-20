// 数据体检：演示前跑一遍，10 秒告诉你数据有没有病
// 用法: node src/check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");

let fails = 0, warns = 0;
const fail = (s) => { fails++; console.log("  ❌ " + s); };
const warn = (s) => { warns++; console.log("  ⚠️  " + s); };
const ok = (s) => console.log("  ✅ " + s);

console.log("=== 1. 商品与品牌 ===");
const total = db.prepare(`SELECT COUNT(*) c FROM product`).get().c;
const active = db.prepare(`SELECT COUNT(*) c FROM product WHERE active=1`).get().c;
const noBrand = db.prepare(`SELECT COUNT(*) c FROM product WHERE active=1 AND (brand IS NULL OR brand='')`).get().c;
const byCat = db.prepare(`SELECT category, COUNT(*) n FROM product WHERE active=1 GROUP BY category ORDER BY n DESC`).all();
console.log(`  商品总数 ${total}，在售 ${active}`);
console.log("  按品类: " + byCat.map((r) => `${r.category}:${r.n}`).join("  "));
const brandRatio = active ? noBrand / active : 0;
brandRatio > 0.3 ? warn(`品牌缺失 ${noBrand}/${active}（${(brandRatio * 100).toFixed(0)}%）`) : ok(`品牌缺失 ${noBrand}/${active}`);

console.log("=== 2. 价格健康度 ===");
const priced = db.prepare(`SELECT COUNT(*) c FROM listing WHERE price IS NOT NULL`).get().c;
const nullPrice = db.prepare(`SELECT COUNT(*) c FROM listing WHERE price IS NULL`).get().c;
const low = db.prepare(`SELECT COUNT(*) c FROM listing WHERE price IS NOT NULL AND price < 10000`).get().c;
const high = db.prepare(`SELECT COUNT(*) c FROM listing WHERE price IS NOT NULL AND price > 10000000`).get().c;
console.log(`  有效报价 ${priced}，空价 ${nullPrice}`);
low ? fail(`低于 100 元的价格 ${low} 条`) : ok("无异常低价");
high ? fail(`高于 10 万元的价格 ${high} 条`) : ok("无异常高价");

console.log("=== 3. 历史点分布 ===");
const pts = db.prepare(`SELECT product_id, COUNT(*) n FROM price_history GROUP BY product_id`).all();
const counts = pts.map((r) => r.n).sort((a, b) => a - b);
const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
console.log(`  有历史点的商品 ${pts.length}，点数为 min=${counts[0] ?? 0} 中位=${median} max=${counts[counts.length - 1] ?? 0}`);
const thin = db.prepare(`SELECT COUNT(*) c FROM product p WHERE p.active=1 AND (SELECT COUNT(*) FROM price_history h WHERE h.product_id=p.id) < 2`).get().c;
thin ? warn(`${thin} 个在售商品只有 0~1 个历史点（曲线会空）`) : ok("所有在售商品都有 ≥2 个历史点");

console.log("=== 4. 最近一轮抓取 ===");
const run = db.prepare(`SELECT * FROM collect_run ORDER BY id DESC LIMIT 1`).get();
if (!run) fail("没有抓取记录");
else {
  console.log(`  #${run.id} ${run.status} 请求=${run.requested} 成功=${run.ok_count} 失败=${run.fail_count} 异常=${run.anomaly_count}`);
  if (run.status === "aborted") warn("最近一轮被中止（多半是源站限速）");
  if (run.requested > 0 && run.ok_count === 0) fail("最近一轮一条都没成功");
}

console.log("=== 5. 重复与一致性 ===");
const dup = db.prepare(`SELECT COUNT(*) c FROM (SELECT product_id, platform, captured_at, COUNT(*) n FROM listing GROUP BY 1,2,3 HAVING n>1)`).get().c;
dup ? fail(`listing 有 ${dup} 组重复`) : ok("listing 无重复");
const dupH = db.prepare(`SELECT COUNT(*) c FROM (SELECT product_id, platform, captured_at, COUNT(*) n FROM price_history GROUP BY 1,2,3 HAVING n>1)`).get().c;
dupH ? fail(`price_history 有 ${dupH} 组重复`) : ok("price_history 无重复");

console.log("=== 6. 快照与图片 ===");
const snapPath = path.join(ROOT, "data", "snapshot.json");
if (!fs.existsSync(snapPath)) fail("snapshot.json 不存在");
else {
  const s = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  console.log(`  snapshot: ${s.generated_at}（导出 ${s.exported_at}）products=${s.counts.products} history=${s.counts.history_points}`);
  const maxCap = db.prepare(`SELECT MAX(captured_at) m FROM price_history`).get().m;
  if (maxCap && maxCap !== s.generated_at) warn(`快照数据时间(${s.generated_at}) 与库内最新(${maxCap}) 不一致 → 该重跑 export`);
  else ok("快照数据时间与库内一致");
  const noImg = s.products.filter((p) => !p.image_local).length;
  noImg ? warn(`${noImg}/${s.products.length} 个商品没有本地图`) : ok("全部商品有本地图");
  const badMsrp = s.deal.filter((d) => d.msrp && (d.msrp < d.price / 10 || d.msrp > d.price * 10)).length;
  badMsrp ? warn(`${badMsrp} 条 msrp 与现价相差 10 倍以上（单位或映射可疑）`) : ok("msrp 与现价量级正常");
}

console.log("=== 7. 第三方参考 ===");
try {
  const bili = db.prepare(`SELECT COUNT(*) c FROM bili_report`).get().c;
  const days = db.prepare(`SELECT COUNT(*) c FROM (SELECT DISTINCT date FROM bili_report)`).get().c;
  bili ? ok(`${bili} 行 / ${days} 天`) : warn("没有参考源数据");
} catch { warn("bili_report 表不存在"); }

console.log("=== 8. 券口径（不许存账号个人券）===");
try {
  const total = db.prepare(`SELECT COUNT(*) c FROM coupon`).get().c;
  if (!total) ok("库里没有券记录（券后价只由用户券实时计算）");
  else {
    const bad = db.prepare(`SELECT COUNT(*) c FROM coupon WHERE is_public IS NULL OR is_public=0`).get().c;
    bad ? fail(`${bad} 条券未标记为公开（is_public=0），可能混入账号个人券`) : ok(`${total} 条券全部标记 public_auto`);
    const pers = db.prepare(`SELECT COUNT(*) c FROM coupon WHERE source IS NOT NULL AND source<>'public_auto'`).get().c;
    if (pers) fail(`${pers} 条券来源不是 public_auto`);
  }
  const personal = db.prepare(`SELECT COUNT(*) c FROM listing WHERE platform='jd' AND (title_raw LIKE '%PLUS%' OR title_raw LIKE '%新人%' OR title_raw LIKE '%百亿补贴%' OR title_raw LIKE '%定向%' OR title_raw LIKE '%专享%' OR title_raw LIKE '%白条%')`).get().c;
  personal ? fail(`${personal} 条京东报价标题含个人化关键词（PLUS/新人/百亿/定向/专享/白条）`) : ok("京东报价无个人化关键词");
} catch { warn("无法检查券口径（coupon 表或缺列）"); }

console.log("");
console.log(fails ? `FAIL —— ${fails} 个错误、${warns} 个警告` : warns ? `PASS（有 ${warns} 个警告）` : "PASS");
db.close();
process.exit(fails ? 1 : 0);
