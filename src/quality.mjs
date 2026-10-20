// 有效性判定：决定哪些商品进快照（active=1）
// 规则：
//   1) 必须有报价（ZOL 或京东自营）
//   2) 显卡/CPU/内存 额外要求是当代型号
//   3) 显卡型号必须能识别出具体芯片（RTX/GTX/RX/ARC + 数字），过滤"AI学习电脑独立显卡"这类白牌
//   4) 其他品类只要有意就能展示
// 用法: node src/quality.mjs [--dry]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isModern } from "./zol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DRY = process.argv.includes("--dry");

const STALE_CHECKED = new Set(["vga", "cpu", "memory"]);

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

const cols = db.prepare(`PRAGMA table_info(product)`).all().map((c) => c.name);
if (!cols.includes("active")) db.exec(`ALTER TABLE product ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
if (!cols.includes("retired")) db.exec(`ALTER TABLE product ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`);

const products = db.prepare(`SELECT id, category, model, retired FROM product ORDER BY category, id`).all();
// 有报价就算"有效的商品"：不再只认 ZOL，京东自营价同样算（否则自营商品会被误隐藏）
const priced = new Set(
  db.prepare(`SELECT DISTINCT product_id FROM listing WHERE price IS NOT NULL`).all().map((r) => r.product_id)
);

const upd = db.prepare(`UPDATE product SET active=? WHERE id=?`);
const byCat = {};
let on = 0, off = 0;
const hidden = [];

for (const p of products) {
  const hasPrice = priced.has(p.id);
  const staleCheck = STALE_CHECKED.has(p.category) ? !isModern(p.model) : false;
  const retired = p.retired === 1; // 被 trim.mjs 主动精简掉的商品
  // 显卡白牌过滤：型号里必须出现具体芯片（RTX/GTX/RX/ARC + 3~4 位数字）
  const gpuNameOk = p.category !== "vga" ? true : /(RTX|GTX|RX|ARC)\s?\d{3,4}/i.test(String(p.model || ""));
  const active = hasPrice && !staleCheck && !retired && gpuNameOk ? 1 : 0;
  if (!DRY) upd.run(active, p.id);
  byCat[p.category] = byCat[p.category] || { on: 0, off: 0 };
  if (active) { on++; byCat[p.category].on++; } else {
    off++; byCat[p.category].off++;
    hidden.push(`#${p.id} [${p.category}] ${hasPrice ? "" : "无报价 "}${retired ? "已精简 " : ""}${staleCheck ? "老型号 " : ""}${gpuNameOk ? "" : "白牌显卡 "}${p.model.slice(0, 34)}`);
  }
}

console.log(`active=1: ${on} | active=0: ${off}`);
console.log("按品类:", Object.entries(byCat).map(([k, v]) => `${k}:${v.on}/${v.on + v.off}`).join("  "));
if (hidden.length) {
  console.log("隐藏的：");
  for (const h of hidden) console.log("  ", h);
}
db.close();
