// 精简商品：每品类限量 + 优先保留主流品牌，其余标记 retired（可逆，不删数据）
// 用法: node src/trim.mjs [--dry]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DRY = process.argv.includes("--dry");

// 每品类保留数量（合计约 80）
const CAP = { vga: 30, memory: 12, power: 12, case: 12, keyboard: 12, projector: 8, router: 8, notebook: 8 };

// 主流品牌优先（不在列表里的排后面，先被裁掉）
const MAINSTREAM = {
  vga: ["华硕", "微星", "技嘉", "七彩虹", "索泰", "影驰", "蓝宝石", "瀚铠", "蓝戟", "intel", "讯景", "映众", "盈通", "万丽"],
  memory: ["金士顿", "威刚", "芝奇", "光威", "英睿达", "三星", "海盗船", "雷克沙", "金百达", "阿斯加特"],
  power: ["长城", "航嘉", "振华", "鑫谷", "先马", "酷冷至尊", "海盗船", "安钛克", "海韵", "台达", "全汉"],
  case: ["追风者", "乔思伯", "迎广", "银欣", "海盗船", "先马", "爱国者", "安钛克", "酷冷至尊", "联力"],
  keyboard: ["雷柏", "达尔优", "黑峡谷", "罗技", "雷蛇", "ikbc", "akko", "keychron", "樱桃", "黑爵"],
  projector: ["极米", "坚果", "当贝", "爱普生", "明基", "优派", "大眼橙", "奥图码", "峰米"],
  router: ["h3c", "华三", "华为", "tp-link", "普联", "小米", "网件", "华硕", "中兴", "锐捷"],
  notebook: ["联想", "华硕", "惠普", "戴尔", "神舟", "宏碁", "华为", "小米"],
};

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
const cols = db.prepare(`PRAGMA table_info(product)`).all().map((c) => c.name);
if (!cols.includes("retired")) db.exec(`ALTER TABLE product ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`);

const products = db.prepare(`SELECT id, category, brand, model FROM product WHERE active=1 ORDER BY category, id`).all();
const priceOf = db.prepare(`SELECT price FROM listing WHERE product_id=? AND price IS NOT NULL ORDER BY captured_at DESC LIMIT 1`);

const byCat = {};
for (const p of products) (byCat[p.category] = byCat[p.category] || []).push(p);

const upd = db.prepare(`UPDATE product SET retired=? WHERE id=?`);
let keep = 0, drop = 0;
console.log("品类      现有  保留  裁掉");
for (const [cat, list] of Object.entries(byCat)) {
  const cap = CAP[cat] ?? list.length;
  const main = (MAINSTREAM[cat] || []).map((b) => b.toLowerCase());
  const ranked = list.slice().sort((a, b) => {
    const ai = main.indexOf(String(a.brand || "").toLowerCase());
    const bi = main.indexOf(String(b.brand || "").toLowerCase());
    const am = ai === -1 ? 999 : ai;
    const bm = bi === -1 ? 999 : bi;
    if (am !== bm) return am - bm;
    // 同档按价格降序（贵的一般更值得展示）
    const ap = priceOf.get(a.id)?.price ?? 0;
    const bp = priceOf.get(b.id)?.price ?? 0;
    return bp - ap;
  });
  ranked.forEach((p, i) => {
    const retire = i >= cap ? 1 : 0;
    if (!DRY) upd.run(retire, p.id);
    if (retire) drop++; else keep++;
  });
  console.log(`${cat.padEnd(10)}${String(list.length).padStart(4)}${String(Math.min(cap, list.length)).padStart(6)}${String(Math.max(0, list.length - cap)).padStart(6)}`);
}
console.log(`\n保留 ${keep} / 标记 retired ${drop}${DRY ? "（dry-run，未写入）" : ""}`);
db.close();
