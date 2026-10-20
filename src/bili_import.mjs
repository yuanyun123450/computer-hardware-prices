// 第三方参考源导入：B站 @芝士华莱士「显卡日报」人工转录 CSV -> bili_report 表
// 用法: node src/bili_import.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CSV = path.join(ROOT, "data", "bili", "reports.csv");
const OUT_JSON = path.join(ROOT, "data", "bili", "export.json");

const SOURCE = "B站 @芝士华莱士 显卡日报（mid 22697887）";
const NOTE = "第三方整理数据：UP 主脚本于当日凌晨爬取，平台名已还原（某东自营→京东自营、某宝→淘宝、某多多→拼多多、某Yin/某音→抖音）。仅作参考，不等同于本平台实测价。";
// 平台名还原：UP 主原文对平台做了匿名化，这里按他页面上的真实写法还原
// 依据：表头「某东自营/某宝/某多多/某Yin」，且店铺列前缀写作「某宝/XX」「某多/XX」「某音/XX」
const PLATFORM_NAMES = {
  jd: "京东自营",
  tb: "淘宝",
  pdd: "拼多多",
  yin: "抖音",
  yin_note: "「某Yin」按其店铺前缀「某音」推断为抖音，属推测",
};

const db = new DatabaseSync(path.join(ROOT, "data", "price.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS bili_report (
  date        TEXT NOT NULL,
  model       TEXT NOT NULL,
  low_hist    INTEGER,
  low_day     INTEGER,
  msrp        INTEGER,
  jd          INTEGER,
  tb          INTEGER,
  pdd         INTEGER,
  yin         INTEGER,
  bv          TEXT,
  frame       TEXT,
  source      TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (date, model)
);
`);

const lines = fs.readFileSync(CSV, "utf8").trim().split(/\r?\n/);
const head = lines.shift().split(",");
const idx = Object.fromEntries(head.map((h, i) => [h, i]));
// 契约：所有金额字段单位是「分」。CSV 里记的是「元」，入库统一 ×100
const int = (v) => (v === "" || v == null ? null : Math.round(Number(v) * 100));

const ins = db.prepare(`
INSERT INTO bili_report (date, model, low_hist, low_day, msrp, jd, tb, pdd, yin, bv, frame, source, imported_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(date, model) DO UPDATE SET
  low_hist=excluded.low_hist, low_day=excluded.low_day, msrp=excluded.msrp,
  jd=excluded.jd, tb=excluded.tb, pdd=excluded.pdd, yin=excluded.yin,
  bv=excluded.bv, frame=excluded.frame, imported_at=excluded.imported_at
`);

const at = nowIso();
let n = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  const c = line.split(",");
  ins.run(
    c[idx.date], c[idx.model],
    int(c[idx.low_hist]), int(c[idx.low_day]), int(c[idx.msrp]),
    int(c[idx.jd]), int(c[idx.tb]), int(c[idx.pdd]), int(c[idx.yin]),
    c[idx.bv], c[idx.frame], SOURCE, at
  );
  n++;
}
console.log(`导入 ${n} 行 -> bili_report`);

// —— 用"原价"回填我们自己商品的 msrp（型号对齐：数字+后缀都命中）——
// 型号 token：保留空格抽取，避免 "RTX 5060 8GB" 被粘成 RTX50608
const facts = (s) => {
  const raw = String(s).toUpperCase();
  const tokens = [...raw.matchAll(/([A-Z]{0,3})\s?(\d{3,5})(?![0-9])/g)].map((m) => (m[1] || "") + m[2]);
  const words = ["SUPER", "TI", "XT"].filter((w) => new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`).test(raw));
  const st = (raw.match(/(\d{1,4})\s*(GB|G)\b/) || [])[0];
  return { tokens: [...new Set(tokens)], words, st: st ? st.replace(/\s/g, "") : null };
};
const models = db.prepare(`SELECT model, msrp FROM bili_report GROUP BY model`).all();
// 参考源全部是显卡，只回填 vga 品类；跨品类（如机箱 570X）绝不能参与匹配
const products = db.prepare(`SELECT id, model, msrp FROM product WHERE category='vga'`).all();
let filled = 0;
for (const p of products) {
  const pf = facts(p.model);
  for (const m of models) {
    const mf = facts(m.model);
    // token 必须全部出现在商品型号里（B570 不能命中 570X / RX570）
    const tokenOk = mf.tokens.length > 0 && mf.tokens.every((x) => pf.tokens.includes(x));
    // 后缀必须"集合完全相等"：XT / Ti / SUPER 不能再漏掉
    const wordOk =
      mf.words.length === pf.words.length && mf.words.every((w) => pf.words.includes(w));
    // 显存也要对得上（有就比）
    const stOk = !mf.st || !pf.st || mf.st === pf.st;
    if (tokenOk && wordOk && stOk) {
      if (p.msrp !== m.msrp) {
        db.prepare(`UPDATE product SET msrp=? WHERE id=?`).run(m.msrp, p.id);
        filled++;
        console.log(`  msrp 回填: #${p.id} ${p.model.slice(0, 34)} <- ${m.model} ￥${(m.msrp / 100).toFixed(0)}`);
      }
      break;
    }
  }
}
console.log(`msrp 回填 ${filled} 个商品`);

// —— 导出给前端/后端的参考源 JSON ——
const rows = db.prepare(`SELECT * FROM bili_report ORDER BY date, model`).all();
const byModel = {};
for (const r of rows) {
  byModel[r.model] = byModel[r.model] || { model: r.model, points: [] };
  byModel[r.model].points.push({
    date: r.date, low_hist: r.low_hist, low_day: r.low_day, msrp: r.msrp,
    jd: r.jd, tb: r.tb, pdd: r.pdd, yin: r.yin,
  });
}
const latestDate = rows.length ? rows[rows.length - 1].date : null;
const dates = [...new Set(rows.map((r) => r.date))].sort();
const out = {
  generated_at: at,
  source: SOURCE,
  note: NOTE,
  platform_names: PLATFORM_NAMES,
  dates,
  latest_date: latestDate,
  series: Object.values(byModel),
  provenance: rows.slice(0, 1).map((r) => ({ bv: r.bv, frame: r.frame })),
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), "utf8");
console.log(`已导出 ${path.relative(ROOT, OUT_JSON)}（${dates.length} 天 × ${Object.keys(byModel).length} 型号）`);
db.close();
