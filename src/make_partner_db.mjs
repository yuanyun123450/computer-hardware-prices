// 生成"只含在售商品"的干净数据库，给协作方（B/C）用
// 用法: node src/make_partner_db.mjs <输出路径>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = process.argv[2];
if (!OUT) {
  console.error("用法: node src/make_partner_db.mjs <输出路径>");
  process.exit(1);
}

const SRC = path.join(ROOT, "data", "price.db");
const tmp = OUT + ".tmp";
for (const f of [tmp, OUT]) if (fs.existsSync(f)) fs.unlinkSync(f);

// 1) 用 VACUUM INTO 拿一份一致性快照（自动合并 WAL）
const src = new DatabaseSync(SRC);
src.exec(`VACUUM INTO '${tmp.replace(/\\/g, "/").replace(/'/g, "''")}'`);
src.close();

// 2) 只保留 active=1 的商品，及其相关记录
const db = new DatabaseSync(tmp);
db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;");
const active = db.prepare(`SELECT COUNT(*) c FROM product WHERE active=1`).get().c;
const before = db.prepare(`SELECT COUNT(*) c FROM product`).get().c;

db.exec(`
  DELETE FROM listing      WHERE product_id NOT IN (SELECT id FROM product WHERE active=1);
  DELETE FROM price_history WHERE product_id NOT IN (SELECT id FROM product WHERE active=1);
  DELETE FROM coupon       WHERE product_id NOT IN (SELECT id FROM product WHERE active=1);
  DELETE FROM product_alias WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM product WHERE active=1);
  DELETE FROM product      WHERE active<>1;
`);
db.exec("VACUUM");
const after = db.prepare(`SELECT COUNT(*) c FROM product`).get().c;
const stale = db.prepare(`SELECT COUNT(*) c FROM listing WHERE product_id NOT IN (SELECT id FROM product)`).get().c;
db.close();

// 3) 原子落位
fs.renameSync(tmp, OUT);

console.log(`源库 product=${before}，在售=${active}`);
console.log(`输出库 product=${after}（应为 ${active}），孤儿 listing=${stale}`);
console.log(`文件: ${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
