// 模糊搜索候选生成：硬门槛过滤 + 加权排序
// 被 /api/search 调用；规则与采集时的商品对齐逻辑保持一致
// 用法（在后端服务里）: const { matchCandidates } = await import('./match.mjs')

const BRAND_ALIAS = {
  讯景: ["讯景", "xfx"], 索泰: ["索泰", "zotac"], 华硕: ["华硕", "asus", "rog"],
  微星: ["微星", "msi"], 七彩虹: ["七彩虹", "colorful", "igame"], 影驰: ["影驰", "galax"],
  技嘉: ["技嘉", "gigabyte", "aorus"], 撼讯: ["撼讯", "powercolor"], 磐镭: ["磐镭", "peladn"],
  映众: ["映众", "inno3d"], 蓝宝石: ["蓝宝石", "sapphire"], 耕升: ["耕升", "gainward"],
  铭瑄: ["铭瑄", "maxsun"], 盈通: ["盈通", "yeston"], 瀚铠: ["瀚铠", "hankai"],
  蓝戟: ["蓝戟", "tri"], 万丽: ["万丽", "manli"], 联想: ["联想", "lenovo"],
  金士顿: ["金士顿", "kingston"], 威刚: ["威刚", "adata"], 三星: ["三星", "samsung"],
  intel: ["intel", "英特尔"], amd: ["amd", "锐龙"],
};

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** 从任意字符串提取：品牌别名命中、型号 token、后缀、容量 */
function facts(text) {
  const raw = String(text || "");
  const t = norm(raw).toUpperCase();
  // 型号 token：允许字母前缀（B570 / RX5700 / RTX4070），避免把 b570 拆成裸数字 570
  const tokens = [...t.matchAll(/([A-Z]{0,3})\s?(\d{3,5})/g)].map((m) => (m[1] || "") + m[2]);
  const nums = [...t.matchAll(/\d{3,5}/g)].map((m) => m[0]);
  let words = ["SUPER", "TI", "XT", "XTX"].filter((w) => new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`).test(t));
  // "4070s" / "4070 S" 当成 SUPER 的缩写
  if (/\d{3,5}\s?S(?![A-Z0-9])/.test(t) && !words.includes("SUPER")) words = [...words, "SUPER"];
  const st = (t.match(/(\d{1,4})\s*(GB|G)\b/) || [])[0];
  const brands = [];
  for (const [k, v] of Object.entries(BRAND_ALIAS)) {
    if (v.some((a) => t.toLowerCase().includes(a))) brands.push(k);
  }
  return {
    tokens: [...new Set(tokens)],
    nums: [...new Set(nums)],
    words: [...new Set(words)],
    st: st ? st.replace(/\s/g, "") : null,
    brands: [...new Set(brands)],
  };
}

/**
 * @param {string} query 用户输入（可以模糊、可以只写型号）
 * @param {Array} products snapshot.products
 * @param {{limit?:number}} opts
 * @returns {Array<{product_id,title,brand,price,image_url,image_local,score,why}>}
 */
export function matchCandidates(query, products, { limit = 5 } = {}) {
  const q = facts(query);
  if (!q.nums.length && !q.brands.length) return [];

  const out = [];
  for (const p of products) {
    const target = `${p.brand || ""} ${p.model || ""}`;
    const pf = facts(target);
    const why = [];
    let score = 0;

    // —— 硬门槛 ——
    // 1) 品牌：用户写了品牌，则商品必须是同一品牌（别名互通）
    if (q.brands.length) {
      const same = q.brands.some((b) => pf.brands.includes(b));
      if (!same) continue;
      score += 25;
      why.push("品牌一致");
    }
    // 2) 型号：带字母前缀的 token 要求完全一致（B570 不能匹配 5700）；纯数字则要求数字出现
    if (q.tokens.length) {
      const miss = q.tokens.filter((tk) => {
        const hasLetter = /^[A-Z]/.test(tk);
        if (hasLetter) return !pf.tokens.includes(tk);
        return !pf.nums.includes(tk);
      });
      if (miss.length) continue;
      score += 45;
      why.push("型号命中 " + q.tokens.join("/"));
    }
    // 3) 后缀：TI/SUPER/XT 必须一致（"4070" 不能匹配 "4070 Ti"）
    if (q.words.length) {
      const miss = q.words.filter((w) => !pf.words.includes(w));
      if (miss.length) continue;
      score += 15;
      why.push("后缀一致 " + q.words.join("/"));
    } else if (pf.words.length) {
      // 用户没写后缀，但商品有后缀：不淘汰，降权（让无后缀的排前面）
      score -= 5;
      why.push("商品带后缀 " + pf.words.join("/"));
    }
    // 4) 容量：用户写了容量就必须一致
    if (q.st) {
      if (pf.st && pf.st !== q.st) continue;
      if (pf.st === q.st) { score += 15; why.push("容量一致 " + q.st); }
    }

    // —— 加分项 ——
    const qWords = norm(query).split(" ").filter((w) => w.length > 1);
    const hit = qWords.filter((w) => norm(target).includes(w)).length;
    if (qWords.length) {
      const cover = hit / qWords.length;
      score += Math.round(cover * 20);
      if (cover === 1) why.push("关键词全覆盖");
    }

    out.push({
      product_id: p.id,
      title: `${p.brand || "品牌未知"} ${p.model || ""}`.trim(),
      brand: p.brand || null,
      model: p.model,
      image_url: p.image_url || null,
      image_local: p.image_local || null,
      score,
      why,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
