// 通用工具：限速、重试、超时、哈希、GBK 解码
import crypto from "node:crypto";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每主机最小请求间隔（毫秒）。设计文档 §2：1 请求 / 2 秒
const MIN_INTERVAL = 2000;
const lastHit = new Map();

async function throttle(url) {
  const host = new URL(url).host;
  const prev = lastHit.get(host) || 0;
  const wait = prev + MIN_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

const UA = "price-watch-hackathon/0.1 (local demo; contact: local)";

/**
 * 抓一个页面：限速 + 超时 + 重试（间隔翻倍）
 * @returns {{ok:boolean, status:number, text:string, bytes:number, ms:number, error?:string}}
 */
export async function fetchText(url, { encoding = "utf-8", retries = 2, timeoutMs = 25000 } = {}) {
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1)); // 2s -> 4s
    await throttle(url);
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html,*/*" },
        signal: ac.signal,
        redirect: "follow",
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const text = new TextDecoder(encoding).decode(buf);
      return { ok: res.ok, status: res.status, text, bytes: buf.length, ms: Date.now() - started };
    } catch (e) {
      lastErr = e.name === "AbortError" ? `timeout ${timeoutMs}ms` : e.message;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, text: "", bytes: 0, ms: 0, error: lastErr };
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const nowIso = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

export const stripHtml = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
