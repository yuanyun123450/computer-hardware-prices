// 比价助手扩展 · content script
// 职责：只在用户点击时，读取当前京东商品页上「可见」的优惠券，POST 到本机比价服务。
// 明确不做：不读 cookie、不发第三方、不自动触发。

const API = "http://127.0.0.1:8787/api/user-coupons";

/** 从任意文本里解析「满 X 减 Y」 */
function parseCouponsFromText(text) {
  const out = [];
  const re = /满\s*(\d+(?:\.\d+)?)\s*元?\s*(?:可)?减\s*(\d+(?:\.\d+)?)\s*元?/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      threshold: Math.round(Number(m[1]) * 100),
      amount: Math.round(Number(m[2]) * 100),
      stackable: false,
      text: m[0],
    });
  }
  // 无门槛券
  const re2 = /无门槛\s*(?:立减)?\s*(\d+(?:\.\d+)?)\s*元?/g;
  while ((m = re2.exec(text))) {
    out.push({ threshold: 0, amount: Math.round(Number(m[1]) * 100), stackable: true, text: m[0] });
  }
  return out;
}

/** 汇总页面里“像券”的可见文本 */
function collectCouponTexts() {
  const chunks = [];
  // 常见容器（京东改版频繁，这里多给几个，找不到也不会崩）
  const sels = ["#couponList", "[class*=coupon]", "[class*=quan]", ".p-promotions", "[class*=promotion]", "[class*=promo]"];
  for (const s of sels) {
    document.querySelectorAll(s).forEach((el) => {
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 300) chunks.push(t);
    });
  }
  // 兜底：整页短句里含「满…减…」的行
  document.querySelectorAll("span,div,li").forEach((el) => {
    if (el.children.length) return;
    const t = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (t.length > 2 && t.length < 60 && /满\s*\d+\s*(元)?\s*(可)?减\s*\d+/.test(t)) chunks.push(t);
  });
  return [...new Set(chunks)];
}

function panel() {
  const old = document.getElementById("__pricewatch_panel");
  if (old) old.remove();

  const sku = (location.pathname.match(/\/(\d+)\.html/) || [])[1];
  const box = document.createElement("div");
  box.id = "__pricewatch_panel";
  box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);padding:12px;font:13px/1.5 system-ui,'Microsoft YaHei';max-width:320px";
  box.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">比价助手 · 我的券</div>
    <div style="color:#888;margin-bottom:8px">SKU ${sku || "未识别"}（只在本机处理）</div>
    <div id="__pw_result" style="white-space:pre-wrap;color:#333;margin-bottom:8px"></div>
    <button id="__pw_sync" style="background:#ff0f23;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer">同步我的券</button>
    <button id="__pw_close" style="border:0;background:#f3f3f3;border-radius:6px;padding:7px 10px;cursor:pointer;margin-left:6px">关闭</button>
  `;
  document.body.appendChild(box);
  box.querySelector("#__pw_close").onclick = () => box.remove();

  const result = box.querySelector("#__pw_result");
  box.querySelector("#__pw_sync").onclick = async () => {
    const texts = collectCouponTexts();
    const coupons = texts.flatMap(parseCouponsFromText).slice(0, 10);
    result.textContent = `找到 ${coupons.length} 张券` + (coupons.length ? "" : "（该页可能没有公开券）");
    if (!coupons.length || !sku) return;
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku, coupons }),
      });
      const j = await res.json();
      result.textContent += `\n已同步到本机比价页（${j.ok ? "成功" : "失败"}）`;
    } catch (e) {
      result.textContent += `\n同步失败：本机比价服务没开？（${e.message}）`;
    }
  };
}

panel();
