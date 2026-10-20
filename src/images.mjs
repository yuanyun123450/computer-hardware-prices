// 商品图本地化：把 image_url 下到 data/images/，并把相对路径写进 image_local
// 用法: node src/images.mjs [--limit 30]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sleep } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIR = path.join(ROOT, "data", "images");
fs.mkdirSync(DIR, { recursive: true });

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

const rows = db
  .prepare(`SELECT id, image_url, image_local FROM product WHERE image_url IS NOT NULL ORDER BY id`)
  .all();

const upd = db.prepare(`UPDATE product SET image_local=? WHERE id=?`);
let ok = 0, skip = 0, fail = 0;

for (const r of rows) {
  const ext = (r.image_url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i) || [])[1] || "jpg";
  const rel = `data/images/${r.id}.${ext.toLowerCase()}`;
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 1024) {
    upd.run(rel, r.id);
    skip++;
    continue;
  }
  try {
    const res = await fetch(r.image_url, {
      headers: {
        // ZOL 图片有防盗链，必须带 referer
        referer: "https://detail.zol.com.cn/",
        "user-agent": "price-watch-hackathon/0.1 (local demo)",
        accept: "image/*",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error("文件过小 " + buf.length);
    fs.writeFileSync(abs, buf);
    upd.run(rel, r.id);
    ok++;
    console.log(`#${r.id} -> ${rel} (${(buf.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    fail++;
    console.log(`#${r.id} 失败: ${e.message}`);
  }
  await sleep(1200);
}

const total = db.prepare(`SELECT COUNT(*) c FROM product WHERE image_local IS NOT NULL`).get().c;
console.log(`\n下载 ${ok} / 复用 ${skip} / 失败 ${fail}；库内已有本地图 ${total} 个`);
db.close();
