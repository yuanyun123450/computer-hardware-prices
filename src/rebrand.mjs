// 用最新的品牌词典，从存着的原商品标题重新识别品牌（只补空值，不覆盖已识别的）
// 用法: node src/rebrand.mjs [--force]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { extractBrand } from "./zol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FORCE = process.argv.includes("--force");

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

const rows = db.prepare(`SELECT id, brand, title_zol, model FROM product ORDER BY id`).all();
const upd = db.prepare(`UPDATE product SET brand=? WHERE id=?`);
let filled = 0, still = [];

for (const r of rows) {
  if (r.brand && !FORCE) continue;
  const src = r.title_zol || r.model || "";
  const b = extractBrand(src);
  if (b) { upd.run(b, r.id); filled++; }
  else still.push(`#${r.id} ${src.slice(0, 40)}`);
}

console.log(`补全品牌 ${filled} 个${FORCE ? "（强制覆盖）" : ""}；仍识别不出 ${still.length} 个`);
for (const s of still.slice(0, 12)) console.log("   ", s);
db.close();
