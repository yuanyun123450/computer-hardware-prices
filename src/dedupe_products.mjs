// 清理重复商品：同品类 + 同品牌 + 同型号（忽略大小写/空格/标点）只保留一个
// 保留规则：历史点多的 > 有京东价的 > id 小的；其余标记 retired
// 用法: node src/dedupe_products.mjs [--dry]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DRY = process.argv.includes("--dry");

const norm = (s) => String(s || "").toUpperCase().replace(/[^0-9A-Z\u4e00-\u9fa5]/g, "");

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

const rows = db.prepare(`
  SELECT p.id, p.category, p.brand, p.model, p.retired,
         (SELECT COUNT(*) FROM price_history h WHERE h.product_id=p.id) AS pts,
         (SELECT COUNT(*) FROM listing l WHERE l.product_id=p.id AND l.platform='jd') AS jd
  FROM product p WHERE p.active=1`).all();

const groups = new Map();
for (const r of rows) {
  const key = [r.category, norm(r.brand), norm(r.model)].join("|");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const upd = db.prepare(`UPDATE product SET retired=1 WHERE id=?`);
let retired = 0;
for (const [, list] of groups) {
  if (list.length < 2) continue;
  list.sort((a, b) => (b.jd - a.jd) || (b.pts - a.pts) || (a.id - b.id));
  const keep = list[0];
  for (const x of list.slice(1)) {
    if (!DRY) upd.run(x.id);
    retired++;
    console.log(`  重复: #${x.id} ${x.brand || ""} ${x.model.slice(0, 30)} → 保留 #${keep.id}（京东价${keep.jd} / 历史${keep.pts}）`);
  }
}
console.log(`\n${DRY ? "（dry-run）" : ""}清理重复 ${retired} 个`);
db.close();
