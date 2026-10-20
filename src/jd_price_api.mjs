// 用京东公开报价接口（p.3.cn）批量刷新已绑定 SKU 的价格 —— 不需要登录、不需要浏览器
// 用途：在 GitHub Actions 或任何服务器上跑（本机可能因 DNS 污染连不上）
// 用法: node src/jd_price_api.mjs [--limit 50]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { nowIso, sleep } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const i = process.argv.indexOf("--limit");
const limit = i > -1 ? Number(process.argv[i + 1]) : 50;

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

const rows = db.prepare(`
  SELECT p.id, p.jd_sku, p.model, COALESCE(m.official, 0) AS official
  FROM product p LEFT JOIN jd_match m ON m.product_id = p.id
  WHERE p.active = 1 AND p.jd_sku IS NOT NULL AND p.jd_sku <> ''
  LIMIT ?`).all(limit);

console.log(`待刷新 ${rows.length} 个 SKU（数据源：p.3.cn 公开报价接口）`);
if (!rows.length) { db.close(); process.exit(0); }

const cents = (s) => {
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

let ok = 0, fail = 0, blocked = 0;
const insert = db.prepare(`
  INSERT INTO listing (product_id, platform, title_raw, url, price, in_stock, seller, seller_type,
                       condition, region, account_kind, coupon_scope, confidence, captured_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

for (const p of rows) {
  const url = `https://item.jd.com/${p.jd_sku}.html`;
  try {
    const r = await fetch(`https://p.3.cn/prices/mgets?skuIds=J_${p.jd_sku}&type=1`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        referer: "https://item.jd.com/",
        accept: "*/*",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = await r.json();
    const item = Array.isArray(arr) ? arr[0] : null;
    const price = item ? cents(item.p) : null;
    if (!price) throw new Error("接口没有返回价格（可能被限流或该 SKU 下柜）");

    const at = nowIso();
    insert.run(
      p.id, "jd", p.model, url, price, null, null,
      p.official ? "official" : "third_party",
      "new", null, "nonplus", "none", p.official ? "ok" : "partial", at
    );
    db.prepare(`INSERT INTO price_history (product_id, platform, price, captured_at) VALUES (?,?,?,?)`).run(p.id, "jd", price, at);
    ok++;
    console.log(`  ✅ #${p.id} ￥${(price / 100).toFixed(2)}（列表价 ${item.op ? "￥" + Number(item.op).toFixed(2) : "-"}）`);
  } catch (e) {
    fail++;
    const msg = String(e.cause?.code || e.message);
    if (/TIMEOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(msg)) blocked++;
    console.log(`  ❌ #${p.id} ${msg}`);
  }
  await sleep(800); // 这个接口很轻，但也不要打太快
}

console.log(`\n接口刷新：成功 ${ok} / 失败 ${fail}（其中网络不可达 ${blocked}）`);
if (ok === 0 && blocked > 0) {
  console.log("提示：本机网络连不上 p.3.cn（常见于 DNS 污染）。这个脚本更适合在 GitHub Actions 里跑。");
}
db.close();
