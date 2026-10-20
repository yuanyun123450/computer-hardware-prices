// ZOL 解析器：列表页 + 商品页。GBK 编码，价格单位转为"分"。
import { stripHtml } from "./util.mjs";

export const ZOL_BASE = "https://detail.zol.com.cn";

// 中文/英文品牌词典（长的在前，避免 "华硕" 被 "华" 之类误伤）
export const BRANDS = [
  "xfx讯景", "讯景", "索泰", "华硕", "微星", "七彩虹", "影驰", "技嘉", "撼讯", "磐镭",
  "映众", "蓝宝石", "迪兰", "耕升", "铭瑄", "盈通", "丽台", "盈嘉", "盈通", "祺祥",
  "昂达", "双敏", "小影霸", "精影", "北影", "铭影", "万丽", "瀚铠", "傲世",
  "中关村", "联想", "戴尔", "惠普", "神舟", "宏碁",
  "intel", "英特尔", "amd", "锐龙", "酷睿",
  "金士顿", "海盗船", "威刚", "芝奇", "光威", "雷克沙", "英睿达", "三星", "海力士",
  "西数", "希捷", "东芝", "铠侠", "致钛", "长江存储",
  // 电源
  "海韵", "振华", "鑫谷", "先马", "爱国者", "安钛克", "酷冷至尊", "骨伽", "台达", "全汉",
  "曜越", "美商海盗船", "艾维克", "长城", "航嘉", "超频三", "利民",
  // 机箱
  "追风者", "迎广", "乔思伯", "银欣", "分形工艺", "恩杰", "九州风神", "联力",
  // 键盘 / 外设
  "雷柏", "达尔优", "黑峡谷", "罗技", "雷蛇", "杜伽", "akko", "ikbc", "珂芝", "渴创",
  "keychron", "高斯", "御斧", "狼蛛", "双飞燕", "樱桃",
  // 路由器 / 网络
  "华三", "h3c", "tp-link", "普联", "网件", "netgear", "中兴", "锐捷", "水星", "腾达",
  // 投影仪
  "极米", "坚果", "当贝", "爱普生", "明基", "奥图码", "优派", "峰米", "索尼", "大眼橙",
  // 通用/其他
  "华为", "荣耀", "小米", "红米", "acer", "cherry", "凌豹", "黑爵", "华擎", "惠科",
];

const PRICE_MIN_CENTS = 100 * 100;        // 100 元
const PRICE_MAX_CENTS = 100000 * 100;     // 10 万元

/** "￥2,699" / "&yen;970-1669"（区间取低端）/ "￥2<em>699</em>" 都尽量拼回合法价；拼不出返回 null */
export function parsePriceCents(rawBlock) {
  const text = stripHtml(rawBlock)
    .replace(/&yen;|&#165;|&amp;yen;/gi, "￥")
    .replace(/\u00a5/g, " ");
  // 区间价：970-1669 -> 取 970（保守：以低端作为该型号参考价）
  const range = text.match(/(\d[\d,]*)\s*[-~至]\s*\d[\d,]*/);
  if (range) {
    const yuan = Number(range[1].replace(/,/g, ""));
    const cents = Math.round(yuan * 100);
    if (cents >= 100 * 100 && cents <= 100000 * 100) return { cents, anomaly: null, range: true };
  }
  const runs = [...text.matchAll(/\d[\d,]*/g)].map((m) => m[0].replace(/,/g, ""));
  if (!runs.length) return { cents: null, anomaly: "no-digits" };
  for (const cand of [runs.join(""), ...runs]) {
    const yuan = Number(cand);
    if (!Number.isFinite(yuan)) continue;
    const cents = Math.round(yuan * 100);
    if (cents >= 100 * 100 && cents <= 100000 * 100) return { cents, anomaly: null };
  }
  return { cents: null, anomaly: "out-of-range:" + runs.join("|") };
}

/** 列表页 -> [{title, url, priceCents, anomaly}] */
export function parseList(html, category) {
  const out = [];
  const blocks = html.split(/<li[\s>]/).slice(1);
  for (const b of blocks) {
    // 商品链接有两种：/vga/index123456.shtml，以及 CPU/内存用的 /series/28/5366_1.html
    const link = b.match(/<a title="([^"]+)" href="(\/(?:[a-z]+\/index\d+\.shtml|series\/\d+\/\d+_\d+\.html))"/);
    if (!link) continue;
    const priceBlock = (b.match(/class="price"[\s\S]{0,200}?<\/p>/) || [""])[0];
    const { cents, anomaly } = parsePriceCents(priceBlock);
    out.push({
      title: link[1].trim(),
      url: ZOL_BASE + link[2],
      priceCents: cents,
      anomaly,
      category,
    });
  }
  return out;
}

/** 商品页 -> {title, imageUrl, params} */
export function parseDetail(html) {
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const og =
    (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] ||
    (html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) || [])[1] ||
    (html.match(/(https?:)?\/\/[a-z0-9.\-]*zol-img\.com\.cn\/product\/[^"' )]+\.(?:jpg|png)/i) || [])[0] ||
    null;
  const imageUrl = og ? (og.startsWith("//") ? "https:" + og : og) : null;
  // 京东联盟链接里带着京东 SKU：union-click.jd.com/jdc?e=jd_100007186412
  const jd = html.match(/union-click\.jd\.com\/jdc\?e=jd_(\d+)/);
  const jdSku = jd ? jd[1] : null;
  return { title, imageUrl, jdSku };
}

/** 是否当代在售型号（用于过滤列表里的停售老型号）。规则可解释：只认这几代命名 */
export function isModern(title) {
  const t = (title || "").toUpperCase();
  return /RTX\s?(40|50)\d0|RX\s?(7|9)\d{3}|ARC\s?[AB]\d{3}|锐龙\s?[789]\s?\d{4}|酷睿\s?(I[3579]-)?1[3-9]\d{3}|DDR5|DDR4/.test(t);
}

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[（(]/g, " ")
    .replace(/[）)]/g, " ")
    .replace(/[，,、/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** 从标题里抽品牌 */
export function extractBrand(title) {
  const t = norm(title);
  for (const b of BRANDS) {
    if (t.includes(b.toLowerCase())) return b;
  }
  return null;
}

/** 抽容量/显存：12GB / 16G / 1TB -> "12gb" */
export function extractStorage(title) {
  const m = (title || "").match(/(\d{1,4})\s*(GB|G|TB|T)\b/i);
  if (!m) return null;
  const unit = m[2].toUpperCase().startsWith("T") ? "tb" : "gb";
  return m[1] + unit;
}

/** 归一化 match_key：brand|model|storage|color */
export function buildMatchKey({ title, brand, storage, color }) {
  let m = norm(title);
  if (brand) m = m.replace(norm(brand), " ");
  m = m.replace(/(\d{1,4})\s*(gb|g|tb|t)\b/gi, " ");
  m = m.replace(/[^\p{L}\p{N}]+/gu, ""); // 只留字母数字（含中文）
  return [brand ? norm(brand) : "", m, storage || "", color || ""].join("|");
}
