// 采集器：抓 ZOL 列表 -> 逐个商品页 -> 幂等入库 -> 写报告
// 用法: node src/collect.mjs --category vga --limit 12
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fetchText, sha256, nowIso } from "./util.mjs";
import { ZOL_BASE, parseList, parseDetail, extractBrand, extractStorage, buildMatchKey, isModern } from "./zol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = path.join(ROOT, "data");
const RAW = path.join(DATA, "raw", "zol");
fs.mkdirSync(RAW, { recursive: true });

// 支持的品类 -> ZOL 列表页路径
// 已实测可用：vga/cpu/memory/power/case/keyboard/router/projector/notebook
// 被 ZOL 风控页拦住的：phone/headphone/monitor/ssd/mouse/tv/mb（别加）
const CATEGORIES = {
  vga: "/vga/",
  cpu: "/cpu/",
  memory: "/memory/",
  power: "/power/",
  case: "/case/",
  keyboard: "/keyboard/",
  router: "/router/",
  projector: "/projector/",
  notebook: "/notebook/",
  printer: "/printer/",
  speaker: "/speaker/",
  ups: "/ups/",
  gamepad: "/gamepad/",
};

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const category = arg("category", "vga");
const limit = Number(arg("limit", "12"));
const page = Number(arg("page", "1"));   // ZOL 列表分页：/vga/2.html

function openDb() {
  const db = new DatabaseSync(path.join(DATA, "price.db"));
  db.exec(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
  const cols = db.prepare(`PRAGMA table_info(product)`).all().map((c) => c.name);
  if (!cols.includes("jd_sku")) db.exec(`ALTER TABLE product ADD COLUMN jd_sku TEXT`);
if (!cols.includes("jd_sku_hint")) db.exec(`ALTER TABLE product ADD COLUMN jd_sku_hint TEXT`);
  return db;
}

function saveRaw(subdir, name, text, url, db, capturedAt) {
  const dir = path.join(RAW, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, text, "utf8");
  const hash = sha256(text);
  db.prepare(
    `INSERT INTO snapshot_file (url, path, sha256, bytes, captured_at) VALUES (?,?,?,?,?)`
  ).run(url, path.relative(ROOT, file), hash, Buffer.byteLength(text), capturedAt);
  return hash;
}

async function main() {
  const db = openDb();
  const started = nowIso();
  const run = db.prepare(`INSERT INTO collect_run (started_at, category, status) VALUES (?,?,'running')`).run(started, category);
  const runId = Number(run.lastInsertRowid);

  const base = CATEGORIES[category];
  const listUrl = ZOL_BASE + (page > 1 ? base.replace(/\/$/, "") + "/" + page + ".html" : base);
  console.log(`[1/3] 抓列表页 ${listUrl}`);
  // 列表页容易被 ZOL 限速，单独放宽重试：4 次、间隔 5s/10s/20s
  let res = await fetchText(listUrl, { encoding: "gbk", retries: 4 });
  if (!res.ok) {
    console.log(`  列表页失败(${res.status} ${res.error || ""})，等 30 秒再试一次`);
    await new Promise((r) => setTimeout(r, 30000));
    res = await fetchText(listUrl, { encoding: "gbk", retries: 2 });
  }
  if (!res.ok) {
    db.prepare(`UPDATE collect_run SET status='aborted', finished_at=?, note=? WHERE id=?`).run(nowIso(), `列表页失败 ${res.status} ${res.error || ""}`, runId);
    console.error("列表页抓取失败:", res.status, res.error);
    process.exit(1);
  }
  saveRaw(category, `${category}_list_${started.replace(/[:+]/g, "")}`, res.text, listUrl, db, started);

  const items = parseList(res.text, category);
  const mode = arg("filter", "modern");
  let pool = items;
  if (mode === "modern") {
    const modern = items.filter((i) => isModern(i.title));
    console.log(`  解析出 ${items.length} 条，其中当代在售 ${modern.length} 条（filter=modern）`);
    if (modern.length >= limit) pool = modern;
    else console.log(`  在售不足 ${limit} 条，退回用全部列表`);
  } else {
    console.log(`  解析出 ${items.length} 条（filter=all）`);
  }
  const picked = pool.slice(0, limit);
  console.log(`  本轮取 ${picked.length} 条`);

  let ok = 0, fail = 0, anomaly = 0;
  for (let i = 0; i < picked.length; i++) {
    const it = picked[i];
    const tag = it.title.slice(0, 28);
    if (it.priceCents == null) {
      anomaly++;
      console.log(`  [${i + 1}/${picked.length}] ⚠ 价格异常(${it.anomaly}) ${tag}`);
    }
    const capturedAt = nowIso();
    try {
      // 商品页：拿图片与更完整的标题
      const d = await fetchText(it.url, { encoding: "gbk" });
      let detail = { title: it.title, imageUrl: null };
      if (d.ok) {
        detail = parseDetail(d.text);
        const slug = (it.url.match(/index(\d+)\.shtml/) || [, "x"])[1];
        saveRaw(category, `item_${slug}_${capturedAt.replace(/[:+]/g, "")}`, d.text, it.url, db, capturedAt);
      }
      const brand = extractBrand(it.title);
      const storage = extractStorage(it.title);
      const matchKey = buildMatchKey({ title: it.title, brand, storage });

      // 幂等：按 match_key 找或建 product
      let prod = db.prepare(`SELECT id FROM product WHERE match_key=?`).get(matchKey);
      let productId;
      if (prod) {
        productId = prod.id;
        db.prepare(`UPDATE product SET title_zol=?, image_url=COALESCE(?, image_url), jd_sku_hint=COALESCE(?, jd_sku_hint) WHERE id=?`).run(
          it.title, detail.imageUrl, detail.jdSku || null, productId
        );
      } else {
        const ins = db.prepare(
          `INSERT INTO product (brand, model, storage, color, category, title_zol, image_url, jd_sku_hint, match_key, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(brand, it.title, storage, null, category, it.title, detail.imageUrl, detail.jdSku || null, matchKey, capturedAt);
        productId = Number(ins.lastInsertRowid);
      }

      if (it.priceCents != null) {
        db.prepare(
          `INSERT INTO listing (product_id, platform, title_raw, url, price, in_stock, region, account_kind, coupon_scope, confidence, captured_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(product_id, platform, captured_at) DO NOTHING`
        ).run(productId, "zol", it.title, it.url, it.priceCents, null, null, "anon", "none", "partial", capturedAt);
        db.prepare(
          `INSERT INTO price_history (product_id, platform, price, captured_at) VALUES (?,?,?,?)
           ON CONFLICT(product_id, platform, captured_at) DO NOTHING`
        ).run(productId, "zol", it.priceCents, capturedAt);
      }

      if (it.priceCents == null) {
        console.log(`  [${i + 1}/${picked.length}] ⚠ 无报价，只记商品不记价 ${tag}`);
      } else {
        ok++;
        console.log(`  [${i + 1}/${picked.length}] ✓ ${tag} ￥${(it.priceCents / 100).toFixed(2)}`);
      }
    } catch (e) {
      fail++;
      console.log(`  [${i + 1}/${picked.length}] ✗ ${tag} — ${e.message}`);
    }
  }

  const failRate = picked.length ? fail / picked.length : 1;
  const status = failRate > 0.3 ? "aborted" : fail > 0 ? "partial" : "ok";
  db.prepare(
    `UPDATE collect_run SET finished_at=?, requested=?, ok_count=?, fail_count=?, anomaly_count=?, status=? WHERE id=?`
  ).run(nowIso(), picked.length, ok, fail, anomaly, status, runId);

  const total = db.prepare(`SELECT COUNT(*) c FROM product`).get().c;
  const hist = db.prepare(`SELECT COUNT(*) c FROM price_history`).get().c;
  console.log(`\n本轮: 请求 ${picked.length} / 成功 ${ok} / 失败 ${fail} / 异常 ${anomaly} / 状态 ${status}`);
  console.log(`库内累计: product ${total} 条, price_history ${hist} 条`);
  db.close();
}

main().catch((e) => {
  console.error("采集器崩溃:", e);
  process.exit(1);
});
