// 归一化京东 SKU 绑定：保证"一个 SKU 只属于一个商品"，且只保留可信绑定
// 不变式（每次合并/采集后都该跑一遍）：
//   1) 已 retired（精简掉）的商品不能有 jd_sku
//   2) jd_sku 必须来自「自营 + 抓到过价（confidence=ok）」的京东报价，或 jd_match.status='matched'
//   3) 一个 jd_sku 只能绑定一个商品；冲突时保留分数最高（同分取 id 小）的
//   4) 已知广告位 SKU 一律清空
// 用法: node src/jd_dedupe.mjs [--dry]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DRY = process.argv.includes("--dry");

const BAD_SKUS = ["100007186412"]; // 从 ZOL 广告位误抽，7 个商品都指向它

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

const clear = db.prepare(`UPDATE product SET jd_sku=NULL WHERE id=?`);
const setReview = db.prepare(`UPDATE jd_match SET status='review', jd_sku=NULL WHERE product_id=?`);
const ensureMatched = db.prepare(`
  INSERT INTO jd_match (product_id, jd_sku, status, matched_at) VALUES (?,?, 'matched', datetime('now'))
  ON CONFLICT(product_id) DO UPDATE SET jd_sku=excluded.jd_sku, status='matched', matched_at=excluded.matched_at`);

const rows = db.prepare(`SELECT id, jd_sku, retired FROM product WHERE jd_sku IS NOT NULL AND jd_sku<>?`).all("");
let clearedRetired = 0, clearedUnverified = 0, kept = 0;

for (const r of rows) {
  if (r.retired === 1) {
    if (!DRY) { clear.run(r.id); setReview.run(r.id); }
    clearedRetired++;
    console.log(`  已精简却仍绑定 → 清空：#${r.id}`);
    continue;
  }
  if (BAD_SKUS.includes(r.jd_sku)) {
    if (!DRY) { clear.run(r.id); setReview.run(r.id); }
    clearedUnverified++;
    console.log(`  广告位 SKU → 清空：#${r.id}`);
    continue;
  }
  // 是否有"自营且抓到过价"的京东报价
  const okListing = db.prepare(`
    SELECT 1 FROM listing WHERE product_id=? AND platform='jd' AND seller_type='official'
      AND confidence='ok' AND url LIKE ? LIMIT 1`).get(r.id, `%${r.jd_sku}%`);
  const m = db.prepare(`SELECT status, score FROM jd_match WHERE product_id=?`).get(r.id);
  const trusted = !!okListing || (m && m.status === "matched");
  if (!trusted) {
    if (!DRY) { clear.run(r.id); setReview.run(r.id); }
    clearedUnverified++;
    console.log(`  无自营验证记录 → 清空：#${r.id} (sku=${r.jd_sku})`);
    continue;
  }
  if (!m) {
    if (!DRY) ensureMatched.run(r.id, r.jd_sku);
    console.log(`  补建映射记录：#${r.id} → matched`);
  } else if (m.status !== "matched") {
    // 有自营验证记录，但状态停在 review/none → 补正为 matched（否则状态与 sku 不一致）
    if (!DRY) ensureMatched.run(r.id, r.jd_sku);
    console.log(`  补正状态：#${r.id} → matched（原 ${m.status}，已验证自营价）`);
  }
  kept++;
}

// —— 同 SKU 多商品：保留最优 ——
const dups = db.prepare(`
  SELECT jd_sku, GROUP_CONCAT(id) ids FROM product
  WHERE jd_sku IS NOT NULL AND jd_sku<>? GROUP BY jd_sku HAVING COUNT(*)>1`).all("");
let demoted = 0;
for (const d of dups) {
  const ids = String(d.ids).split(",").map(Number);
  const scored = ids.map((id) => {
    const m = db.prepare(`SELECT score, official FROM jd_match WHERE product_id=?`).get(id);
    return { id, score: m?.score ?? 0, official: m?.official ?? 0 };
  }).sort((a, b) => (b.official - a.official) || (b.score - a.score) || (a.id - b.id));
  const keep = scored[0];
  for (const x of scored.slice(1)) {
    if (!DRY) { clear.run(x.id); setReview.run(x.id); }
    demoted++;
    console.log(`  SKU ${d.jd_sku} 重复：保留 #${keep.id}(分${keep.score})，降级 #${x.id}`);
  }
}

const left = db.prepare(`SELECT COUNT(*) c FROM product WHERE jd_sku IS NOT NULL AND jd_sku<>?`).get("").c;
const dupLeft = db.prepare(`SELECT COUNT(*) c FROM (SELECT jd_sku FROM product WHERE jd_sku IS NOT NULL AND jd_sku<>? GROUP BY jd_sku HAVING COUNT(*)>1)`).get("").c;

console.log(`\n清空：已精简 ${clearedRetired} / 未验证 ${clearedUnverified}；降级 ${demoted}；保留可信 ${kept}${DRY ? "（dry-run）" : ""}`);
console.log(`最终绑定商品 ${left} 个；重复 SKU 组 ${dupLeft}`);
db.close();
