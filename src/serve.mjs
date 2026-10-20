// 联调桥：把 data/snapshot.json 变成接口 + 托管前端静态文件
// 只用于本地联调/演示；后端同学按手册 B1 写正式版后可以替换掉它
// 用法: node src/serve.mjs [--port 8787]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { nowIso } from "./util.mjs";
import { DatabaseSync } from "node:sqlite";
import { matchCandidates } from "./match.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SNAP = path.join(ROOT, "data", "snapshot.json");
const WEB = path.join(ROOT, "web");

function arg(n, d) {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
const PORT = Number(arg("port", "8787"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".csv": "text/csv; charset=utf-8",
};

let collecting = false;
let lastRun = 0;
let lastRefresh = null; // { started_at, finished_at, data_at_before, data_at_after, data_changed }

// 京东实时价：内存缓存 + 并发合并（避免同一商品被反复抓）
const serveJdPriceCache = new Map();
const jdPriceInflight = new Map();

// —— 用户券：只在内存里放 10 分钟，不落库、不打日志内容 ——
const couponStore = new Map(); // sku -> { coupons, received_at }
const COUPON_TTL_MS = 10 * 60 * 1000;

/** 券后价计算：规则见 docs/后端任务书.md 8.3 */
function computeQuote({ price, auto_promo = 0, user_coupons = [] }) {
  const pIn = Number(price);
  if (!Number.isFinite(pIn) || pIn < 0) throw new Error("price 必须是非负数字（单位：分）");
  const p = Math.round(pIn);
  // auto_promo 只允许非负：负数会把价格加上去（历史 bug）
  const ap = Math.max(0, Math.round(Number(auto_promo) || 0));
  const pricePromo = Math.max(0, p - ap);

  const usable = [], blocked = [];
  for (const c of Array.isArray(user_coupons) ? user_coupons : []) {
    const th = Math.round(Number(c.threshold) || 0);
    const am = Math.round(Number(c.amount) || 0);
    if (am <= 0) continue;
    if (th <= p) usable.push({ threshold: th, amount: am, stackable: !!c.stackable });
    else blocked.push({ threshold: th, amount: am, need: th - p });
  }

  // 互斥券里取最优一张；可叠加券在其之上累加
  const exclusive = usable.filter((c) => !c.stackable).sort((a, b) => b.amount - a.amount);
  const stackable = usable.filter((c) => c.stackable);
  const applied = [];
  let deduct = 0;
  if (exclusive[0]) { applied.push({ ...exclusive[0], reason: "已满足门槛，取最优" }); deduct += exclusive[0].amount; }
  for (const s of stackable) { applied.push({ ...s, reason: "可叠加" }); deduct += s.amount; }

  const final = Math.max(0, pricePromo - deduct);
  const notes = blocked.map((c) => `再买 ￥${(c.need / 100).toFixed(2)} 可用「满${c.threshold / 100}减${c.amount / 100}」`);

  return { price: p, price_promo: pricePromo, price_user: Math.max(0, pricePromo - deduct), final, applied, notes };
}

let aliasDb = null;
function getAliasDb() {
  if (aliasDb) return aliasDb;
  const p = path.join(ROOT, "data", "price.db");
  if (!fs.existsSync(p)) return null;
  aliasDb = new DatabaseSync(p);
  aliasDb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  aliasDb.exec(`CREATE TABLE IF NOT EXISTS product_alias (
    id INTEGER PRIMARY KEY, raw_title TEXT NOT NULL UNIQUE, product_id INTEGER,
    source TEXT NOT NULL, created_at TEXT NOT NULL)`);
  return aliasDb;
}

const readBody = (req) =>
  new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); }
    });
  });

/** 只允许本机页面与浏览器扩展跨域读取（避免任意网页读用户券） */
const originAllowed = (o) =>
  !o || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) || /^chrome-extension:\/\//.test(o) || /^moz-extension:\/\//.test(o);

const json = (res, code, obj, origin) => {
  const body = JSON.stringify(obj);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": origin && originAllowed(origin) ? origin : "*",
  };
  if (origin) headers["vary"] = "origin";
  res.writeHead(code, headers);
  res.end(body);
};

const readSnapshot = () => {
  if (!fs.existsSync(SNAP)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAP, "utf8"));
  } catch {
    return null;
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // —— 接口 ——
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": originAllowed(req.headers.origin) ? req.headers.origin || "*" : "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    });
    return res.end();
  }

  if (pathname === "/api/health") {
    const s = readSnapshot();
    // 真探活：直接查一次库，而不是只看快照文件在不在
    let dbState = "ok", lastCollect = null;
    try {
      const db = getAliasDb();
      if (!db) dbState = "missing";
      else {
        db.prepare("SELECT 1 AS x").get();
        const row = db.prepare("SELECT started_at FROM collect_run ORDER BY id DESC LIMIT 1").get();
        lastCollect = row ? row.started_at : null;
      }
    } catch { dbState = "error"; }
    return json(res, 200, {
      ok: true,
      data: {
        db: dbState,
        data_at: s ? s.generated_at : null,
        exported_at: s ? s.exported_at || null : null,
        last_collect_at: lastCollect,
        collecting,
      },
      error: null,
      generated_at: nowIso(),
    }, req.headers.origin);
  }

  if (pathname === "/api/snapshot") {
    const s = readSnapshot();
    if (!s) return json(res, 200, { ok: false, data: null, error: { code: "NOT_READY", message: "还没有数据，先跑一次 src/export.mjs" }, generated_at: nowIso() });
    return json(res, 200, { ok: true, data: s, error: null, generated_at: s.generated_at });
  }

  if (pathname === "/api/collect/status") {
    const s = readSnapshot();
    return json(res, 200, {
      ok: true,
      data: { collecting, last_snapshot_at: s ? s.generated_at : null, last_refresh: lastRefresh, runs: s ? s.collect_runs : [] },
      error: null,
      generated_at: nowIso(),
    });
  }

  if (pathname === "/api/refresh" && req.method === "POST") {
    // 先确认整条链路都在（交付包里只给前端时可能没有），否则明确失败，不要假装刷新成功
    const need = ["src/collect.mjs", "src/zol.mjs", "src/quality.mjs", "src/export.mjs"].map((f) => path.join(ROOT, f));
    const missing = need.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      return json(res, 200, {
        ok: false,
        data: { refreshed: false, reason: "collectors_missing", missing: missing.map((f) => path.relative(ROOT, f)) },
        error: { code: "NOT_AVAILABLE", message: "本机没有采集脚本，无法刷新（只能读现有快照）" },
        generated_at: nowIso(),
      }, req.headers.origin);
    }
    const now = Date.now();
    if (collecting) return json(res, 200, { ok: true, data: { refreshed: false, retry_after: 30, reason: "running" }, error: null, generated_at: nowIso() }, req.headers.origin);
    if (now - lastRun < 60000) {
      return json(res, 200, { ok: true, data: { refreshed: false, retry_after: Math.ceil((60000 - (now - lastRun)) / 1000), reason: "cooldown" }, error: null, generated_at: nowIso() }, req.headers.origin);
    }
    lastRun = now;
    collecting = true;
    const before = (readSnapshot() || {}).generated_at || null;
    const startedAt = nowIso();
    const logDir = path.join(ROOT, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = startedAt.replace(/[:+]/g, "").slice(0, 15);
    const logPath = path.join(logDir, `collect-${stamp}.log`);

    // 单步执行：带 error 事件与超时，避免 collecting 永久卡死
    const runStep = (script, args, fd, timeoutMs = 300000) =>
      new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
        const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ["ignore", fd, fd] });
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done({ code: "timeout" }); }, timeoutMs);
        child.on("error", (e) => done({ code: "error", error: e.message }));
        child.on("exit", (code) => done({ code }));
      });

    (async () => {
      const fd = fs.openSync(logPath, "a");
      try {
        const c = await runStep("src/collect.mjs", ["--category", "vga", "--limit", "22", "--filter", "modern"], fd);
        const q = await runStep("src/quality.mjs", [], fd);
        const e = await runStep("src/export.mjs", [], fd);
        const s = readSnapshot();
        const after = s ? s.generated_at : null;
        lastRefresh = {
          started_at: startedAt,
          finished_at: nowIso(),
          exits: { collect: c.code, quality: q.code, export: e.code },
          data_at_before: before,
          data_at_after: after,
          data_changed: !!after && after !== before,
        };
        console.log(`[refresh] collect=${c.code} quality=${q.code} export=${e.code} data_changed=${lastRefresh.data_changed} (${before} -> ${after})`);
      } catch (err) {
        lastRefresh = { started_at: startedAt, finished_at: nowIso(), error: String(err && err.message || err), data_at_before: before, data_at_after: null, data_changed: false };
        console.log("[refresh] 失败: " + lastRefresh.error);
      } finally {
        try { fs.closeSync(fd); } catch {}
        collecting = false;
      }
    })();

    return json(res, 200, { ok: true, data: { refreshed: true, started_at: startedAt, data_at_before: before }, error: null, generated_at: nowIso() }, req.headers.origin);
  }

  // —— 单个商品京东价实时抓取（按需，5 分钟缓存，防重复并发） ——
  const jdPriceCache = serveJdPriceCache; // 复用模块级缓存
  if (pathname === "/api/jd-price") {
    const pid = Number(url.searchParams.get("product_id"));
    if (!pid) return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: "需要 product_id" }, generated_at: nowIso() }, req.headers.origin);

    const cached = jdPriceCache.get(pid);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
      return json(res, 200, { ok: true, data: { ...cached.payload, cached: true }, error: null, generated_at: nowIso() }, req.headers.origin);
    }

    const db = getAliasDb();
    if (!db) return json(res, 200, { ok: false, data: null, error: { code: "NOT_AVAILABLE", message: "没有数据库" }, generated_at: nowIso() }, req.headers.origin);
    const row = db.prepare(`SELECT jd_sku FROM product WHERE id=?`).get(pid);
    if (!row || !row.jd_sku) {
      return json(res, 200, { ok: true, data: { product_id: pid, available: false, reason: "no_sku", message: "该商品尚未关联京东 SKU" }, error: null, generated_at: nowIso() }, req.headers.origin);
    }

    // —— 用京东公开报价接口（p.3.cn）取价：不需要登录、不需要浏览器 ——
    const startedIso = nowIso();
    const off = db.prepare(`SELECT COALESCE(official,0) AS official FROM jd_match WHERE product_id=?`).get(pid);
    const official = !!(off && off.official);
    let apiPrice = null, apiOp = null, apiErr = null;

    try {
      const r = await fetch(`https://p.3.cn/prices/mgets?skuIds=J_${row.jd_sku}&type=1`, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
          referer: "https://item.jd.com/",
          accept: "*/*",
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const arr = await r.json();
      const it = Array.isArray(arr) ? arr[0] : null;
      if (!it || !it.p) throw new Error("接口未返回价格");
      apiPrice = Math.round(Number(it.p) * 100);
      apiOp = it.op ? Math.round(Number(it.op) * 100) : null;
      if (!Number.isFinite(apiPrice) || apiPrice <= 0) throw new Error("价格解析失败");
    } catch (e) {
      apiErr = String((e && e.cause && e.cause.code) || (e && e.message) || e);
    }

    if (apiPrice) {
      const at = nowIso();
      db.prepare(`INSERT INTO listing (product_id, platform, title_raw, url, price, in_stock, seller, seller_type,
                                    condition, region, account_kind, coupon_scope, confidence, captured_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        pid, "jd", null, `https://item.jd.com/${row.jd_sku}.html`, apiPrice, null, null,
        official ? "official" : "third_party", "new", null, "nonplus", "none",
        official ? "ok" : "partial", at
      );
      db.prepare(`INSERT INTO price_history (product_id, platform, price, captured_at) VALUES (?,?,?,?)`).run(pid, "jd", apiPrice, at);
    }

    const l = db.prepare(`SELECT price, seller_type, confidence, coupon_scope, captured_at FROM listing
                          WHERE product_id=? AND platform='jd' ORDER BY captured_at DESC LIMIT 1`).get(pid);
    // 关键：必须判断“这次真的写入了新数据”，否则宁可说失败，也不能拿旧价冒充实时价
    const fresh = !!(l && l.captured_at && l.captured_at >= startedIso);
    if (!fresh) {
      return json(res, 200, {
        ok: true,
        data: {
          product_id: pid,
          available: false,
          reason: "fetch_failed",
          message: "本次没拿到京东价（接口不可达或被限流）；以下为上次价格" + (apiErr ? " · " + apiErr : ""),
          last_price: l ? l.price : null,
          last_captured_at: l ? l.captured_at : null,
        },
        error: null,
        generated_at: nowIso(),
      }, req.headers.origin);
    }
    const payload = {
      product_id: pid,
      available: true,
      fresh: true,
      jd_sku: row.jd_sku,
      price: l.price,
      seller_type: l.seller_type,
      confidence: l.confidence,
      coupon_scope: l.coupon_scope,
      captured_at: l.captured_at,
    };
    jdPriceCache.set(pid, { at: Date.now(), payload });
    return json(res, 200, { ok: true, data: { ...payload, cached: false }, error: null, generated_at: nowIso() }, req.headers.origin);
  }

  // —— 商品 ↔ 京东 SKU 映射（建立/确认/查询） ——
  if (pathname === "/api/jd-match") {
    const db = getAliasDb();
    if (!db) return json(res, 200, { ok: false, data: null, error: { code: "NOT_AVAILABLE", message: "没有数据库" }, generated_at: nowIso() }, req.headers.origin);
    db.exec(`CREATE TABLE IF NOT EXISTS jd_match (
      product_id INTEGER PRIMARY KEY, jd_sku TEXT, jd_title TEXT, store TEXT,
      official INTEGER NOT NULL DEFAULT 0, score INTEGER, status TEXT NOT NULL,
      candidates TEXT, matched_at TEXT NOT NULL)`);

    if (req.method === "POST") {
      const body = await readBody(req);
      const pid = Number(body.product_id);
      const sku = String(body.jd_sku || "").trim();
      if (!pid || !/^\d{6,}$/.test(sku)) {
        return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: "需要 product_id 与合法 jd_sku" }, generated_at: nowIso() }, req.headers.origin);
      }
      const s = readSnapshot();
      if (s && !s.products.some((x) => x.id === pid)) {
        return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: `product_id ${pid} 不存在` }, generated_at: nowIso() }, req.headers.origin);
      }
      const at = nowIso();
      db.prepare(`INSERT INTO jd_match (product_id, jd_sku, status, matched_at) VALUES (?,?,?,?)
        ON CONFLICT(product_id) DO UPDATE SET jd_sku=excluded.jd_sku, status='matched', matched_at=excluded.matched_at`).run(pid, sku, "matched", at);
      db.prepare(`UPDATE product SET jd_sku=? WHERE id=?`).run(sku, pid);
      return json(res, 200, { ok: true, data: { product_id: pid, jd_sku: sku, status: "matched", matched_at: at }, error: null, generated_at: at }, req.headers.origin);
    }

    const status = url.searchParams.get("status") || "";
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const rows = db.prepare(`
      SELECT m.product_id, m.jd_sku, m.jd_title, m.official, m.score, m.status, m.candidates, m.matched_at,
             p.model, p.brand, p.category
      FROM jd_match m JOIN product p ON p.id=m.product_id
      ${status ? "WHERE m.status=?" : ""}
      ORDER BY CASE m.status WHEN 'review' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END, m.product_id
      LIMIT ?`).all(...(status ? [status, limit] : [limit]));
    const counts = db.prepare(`SELECT status, COUNT(*) n FROM jd_match GROUP BY status`).all();
    return json(res, 200, {
      ok: true,
      data: {
        counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        items: rows.map((r) => ({ ...r, candidates: r.candidates ? JSON.parse(r.candidates) : [] })),
      },
      error: null,
      generated_at: nowIso(),
    }, req.headers.origin);
  }

  // —— 商品图：/api/images/<file> 映射到 data/images/（只允许 basename，防目录穿越） ——
  if (pathname.startsWith("/api/images/")) {
    const name = path.basename(pathname.slice("/api/images/".length));
    const file = path.join(ROOT, "data", "images", name);
    if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return json(res, 404, { ok: false, data: null, error: { code: "NOT_FOUND", message: "图片不存在: " + name }, generated_at: nowIso() }, req.headers.origin);
    }
    res.writeHead(200, { "content-type": MIME[path.extname(name).toLowerCase()] || "application/octet-stream", "cache-control": "public, max-age=3600" });
    return fs.createReadStream(file).pipe(res);
  }

  // —— 用户券：扩展上报，只存内存（TTL 10 分钟） ——
  if (pathname === "/api/user-coupons") {
    if (!originAllowed(req.headers.origin)) {
      return json(res, 403, { ok: false, data: null, error: { code: "FORBIDDEN", message: "只允许本机页面或浏览器扩展访问" }, generated_at: nowIso() }, req.headers.origin);
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const sku = String(body.sku || "");
      if (!sku) return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: "sku 必填" }, generated_at: nowIso() }, req.headers.origin);
      const list = Array.isArray(body.coupons) ? body.coupons : [];
      // 越界必须"拒绝"，不能静默丢弃（否则扩展以为成功、用户券没生效）
      const invalid = [];
      const clean = [];
      for (const c of list.slice(0, 20)) {
        const threshold = Math.round(Number(c.threshold) || 0);
        const amount = Math.round(Number(c.amount) || 0);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 500000 || !Number.isFinite(threshold) || threshold < 0 || threshold > 10000000) {
          invalid.push({ threshold: c.threshold, amount: c.amount });
          continue;
        }
        clean.push({ threshold, amount, stackable: !!c.stackable });
      }
      if (invalid.length) {
        return json(res, 200, {
          ok: false,
          data: { stored: 0, rejected: invalid },
          error: { code: "BAD_REQUEST", message: `有 ${invalid.length} 张券参数越界（amount≤500000 分、threshold≤10000000 分），全部未保存` },
          generated_at: nowIso(),
        }, req.headers.origin);
      }
      couponStore.set(sku, { coupons: clean.slice(0, 10), received_at: nowIso(), ts: Date.now() });
      return json(res, 200, { ok: true, data: { stored: Math.min(clean.length, 10), ttl_seconds: 600 }, error: null, generated_at: nowIso() }, req.headers.origin);
    }
    const sku = url.searchParams.get("sku") || "";
    const rec = couponStore.get(sku);
    if (rec && Date.now() - rec.ts > COUPON_TTL_MS) couponStore.delete(sku);
    const alive = couponStore.get(sku);
    return json(res, 200, {
      ok: true,
      data: { coupons: alive ? alive.coupons : [], received_at: alive ? alive.received_at : null },
      error: null,
      generated_at: nowIso(),
    }, req.headers.origin);
  }

  // —— 券后价计算 ——
  if (pathname === "/api/quote" && req.method === "POST") {
    const body = await readBody(req);
    if (body.price == null) return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: "price 必填（单位：分）" }, generated_at: nowIso() }, req.headers.origin);
    try {
      return json(res, 200, { ok: true, data: computeQuote(body), error: null, generated_at: nowIso() }, req.headers.origin);
    } catch (e) {
      return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: String(e.message || e) }, generated_at: nowIso() }, req.headers.origin);
    }
  }

  // —— 模糊搜索：先查别名表，再走规则匹配 ——
  if (pathname === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim();
    const s = readSnapshot();
    if (!s) return json(res, 200, { ok: false, data: null, error: { code: "NOT_READY", message: "还没有数据" }, generated_at: nowIso() });
    if (!q) return json(res, 200, { ok: true, data: { candidates: [], source: "empty" }, error: null, generated_at: nowIso() });

    const priceOf = (id) => (s.deal.find((d) => d.product_id === id) || {}).price ?? null;
    const db = getAliasDb();
    if (db) {
      const hit = db.prepare(`SELECT product_id, source FROM product_alias WHERE raw_title=?`).get(q);
      // 用户点过"都不对"：直接返回空态，不再抛出同一批错误候选
      if (hit && hit.product_id == null && hit.source === "user_reject") {
        return json(res, 200, { ok: true, data: { candidates: [], source: "alias_reject", note: "你之前标记过「都不对」" }, error: null, generated_at: nowIso() }, req.headers.origin);
      }
      if (hit && hit.product_id) {
        const p = s.products.find((x) => x.id === hit.product_id);
        if (p) {
          return json(res, 200, {
            data: { candidates: [{ product_id: p.id, title: `${p.brand || ""} ${p.model}`, brand: p.brand, price: priceOf(p.id), image_url: p.image_url, image_local: p.image_local, score: 100, why: ["你之前选过这个"] }], source: "alias" },
            ok: true,
            error: null,
            generated_at: nowIso(),
          }, req.headers.origin);
        }
      }
    }
    const cands = matchCandidates(q, s.products, { limit: 5 }).map((c) => ({ ...c, price: priceOf(c.product_id) }));
    return json(res, 200, { ok: true, data: { candidates: cands, source: "rule" }, error: null, generated_at: nowIso() }, req.headers.origin);
  }

  // —— 记住用户的选择 ——
  if (pathname === "/api/alias" && req.method === "POST") {
    const body = await readBody(req);
    const raw = String(body.raw_title || "").trim();
    if (!raw) return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: "raw_title 必填" }, generated_at: nowIso() });
    const db = getAliasDb();
    if (!db) return json(res, 200, { ok: false, data: null, error: { code: "NOT_AVAILABLE", message: "没有数据库，无法保存" }, generated_at: nowIso() });
    const pid = body.product_id == null ? null : Number(body.product_id);
    // 别名不能指向不存在的商品（否则用户的选择会静默丢失）
    if (pid != null) {
      const s = readSnapshot();
      if (!s || !s.products.some((x) => x.id === pid)) {
        return json(res, 200, { ok: false, data: null, error: { code: "BAD_REQUEST", message: `product_id ${pid} 不存在` }, generated_at: nowIso() }, req.headers.origin);
      }
    }
    db.prepare(
      `INSERT INTO product_alias (raw_title, product_id, source, created_at) VALUES (?,?,?,?)
       ON CONFLICT(raw_title) DO UPDATE SET product_id=excluded.product_id, source=excluded.source, created_at=excluded.created_at`
    ).run(raw, pid, pid ? "user_pick" : "user_reject", nowIso());
    return json(res, 200, { ok: true, data: { saved: true, raw_title: raw, product_id: pid }, error: null, generated_at: nowIso() }, req.headers.origin);
  }

  if (pathname.startsWith("/api/")) {
    return json(res, 200, { ok: false, data: null, error: { code: "NOT_IMPLEMENTED", message: "该接口还没做（见手册 B1/B2）" }, generated_at: nowIso() });
  }

  // —— 静态文件：只放行白名单路径（否则 price.db / 源码 / 日志 / browser-profile 都会被下载）——
  let file = null;
  if (pathname === "/" || pathname === "/index.html") {
    file = path.join(WEB, "index.html");
  } else if (pathname.startsWith("/web/")) {
    const p = path.join(ROOT, pathname);
    if (p.startsWith(WEB)) file = p;
  } else if (pathname.startsWith("/data/images/")) {
    const name = path.basename(pathname.slice("/data/images/".length));
    const p = path.join(ROOT, "data", "images", name);
    if (name && fs.existsSync(p)) file = p;
  } else if (["/data/snapshot.json", "/data/bili/export.json", "/data/bili/reports.csv"].includes(pathname)) {
    file = path.join(ROOT, pathname);
  }

  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end(`404 ${pathname}\n可用路径：/ 、/web/* 、/data/images/* 、/data/snapshot.json 、/data/bili/export.json 、/api/*`);
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  console.log(`联调服务已启动：http://localhost:${PORT}`);
  console.log(`  健康检查   http://localhost:${PORT}/api/health`);
  console.log(`  全量快照   http://localhost:${PORT}/api/snapshot`);
  console.log(`  静态文件   前端放 web/index.html；data/snapshot.json 也可直接取`);
  fs.mkdirSync(WEB, { recursive: true });
});
