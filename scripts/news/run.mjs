import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "src", "data", "news");
const itemsDir = path.join(dataDir, "items");
const reportsDir = path.join(dataDir, "reports");
const logsDir = path.join(dataDir, "logs");

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const userAgent =
  "trend-radar-news-learning-bot/0.1 (+https://open.qiyuebao.xyz; headline summary)";
const globalLimit = Number.parseInt(process.env.NEWS_GLOBAL_LIMIT ?? "20", 10);
const techLimit = Number.parseInt(process.env.NEWS_TECH_LIMIT ?? "20", 10);
const sourceTimeoutMs = Number.parseInt(process.env.NEWS_FETCH_TIMEOUT_MS ?? "16000", 10);

const openaiConfig = {
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

async function ensureDirs() {
  await Promise.all([
    mkdir(itemsDir, { recursive: true }),
    mkdir(reportsDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
  ]);
}

async function appendLog(type, payload) {
  const line = JSON.stringify({ type, at: new Date().toISOString(), ...payload }) + "\n";
  await writeFile(path.join(logsDir, "news_logs.jsonl"), line, { flag: "a" });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sourceTimeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: options.accept ?? "*/*",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
  return (await fetchWithTimeout(url, options)).text();
}

async function fetchJson(url, options = {}) {
  return (await fetchWithTimeout(url, { ...options, accept: "application/json" })).json();
}

function decodeEntities(value = "") {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(value = "") {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickXml(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripHtml(match[1]) : "";
}

function pickAtomLink(block) {
  const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  if (hrefMatch) return decodeEntities(hrefMatch[1]);
  return pickXml(block, "link");
}

function parseFeed(xml, source, category) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(match => match[0]);
  const atomBlocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(match => match[0]);
  const rssItems = blocks.map(block => ({
      source,
      category,
      originalTitle: pickXml(block, "title"),
      summary: pickXml(block, "description"),
      url: pickXml(block, "link"),
      publishedAt: normalizeDate(pickXml(block, "pubDate") || pickXml(block, "dc:date")),
    }));
  const atomItems = atomBlocks.map(block => ({
      source,
      category,
      originalTitle: pickXml(block, "title"),
      summary: pickXml(block, "summary") || pickXml(block, "content"),
      url: pickAtomLink(block),
      publishedAt: normalizeDate(pickXml(block, "published") || pickXml(block, "updated")),
    }));
  return [...rssItems, ...atomItems]
    .filter(item => item.originalTitle && item.url);
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 88);
}

function stableId(item) {
  const base = `${item.source}-${item.url || item.originalTitle}`;
  let hash = 0;
  for (let index = 0; index < base.length; index += 1) {
    hash = (hash * 31 + base.charCodeAt(index)) >>> 0;
  }
  return `${slugify(item.source)}-${hash.toString(16)}`;
}

function scoreNews(item) {
  let score = 50;
  const text = `${item.originalTitle} ${item.summary}`.toLowerCase();
  if (/breaking|live|war|election|policy|rate|ai|openai|nvidia|model|security/.test(text)) score += 12;
  if (/analysis|explainer|exclusive|investigation/.test(text)) score += 8;
  if (item.source === "GDELT") score += 6;
  if (item.source === "BBC" || item.source === "Guardian") score += 5;
  if (item.source === "Hacker News") score += Math.min(20, Math.round((item.points ?? 0) / 80));
  if (item.source === "Product Hunt") score += 7;
  if (item.publishedAt) {
    const ageHours = (Date.now() - new Date(item.publishedAt).getTime()) / 36e5;
    if (ageHours <= 24) score += 10;
    else if (ageHours <= 72) score += 4;
  }
  return Math.max(0, Math.min(100, score));
}

function classifyTags(item) {
  const text = `${item.originalTitle} ${item.summary}`.toLowerCase();
  const tags = new Set();
  const rules = [
    ["AI", [" ai ", "artificial intelligence", "openai", "model", "llm", "nvidia", "hugging face"]],
    ["科技", ["tech", "software", "startup", "app", "platform", "internet"]],
    ["全球", ["world", "global", "china", "us", "europe", "russia", "ukraine", "israel"]],
    ["金融", ["market", "stock", "bank", "rate", "inflation", "fed", "economy"]],
    ["安全", ["security", "cyber", "privacy", "hack", "breach"]],
    ["产品", ["product", "launch", "tool", "founder"]],
  ];
  for (const [tag, keywords] of rules) {
    if (keywords.some(keyword => text.includes(keyword))) tags.add(tag);
  }
  if (!tags.size) tags.add(item.category === "ai-tech" ? "科技" : "全球");
  return [...tags].slice(0, 4);
}

function sourceWeight(source) {
  return {
    GDELT: 95,
    BBC: 90,
    Guardian: 88,
    "Hacker News": 86,
    "Product Hunt": 84,
    "Hugging Face": 82,
    "The Verge": 80,
  }[source] ?? 60;
}

function normalizeItem(raw) {
  const item = {
    ...raw,
    id: stableId(raw),
    slug: stableId(raw),
    originalTitle: stripHtml(raw.originalTitle),
    summary: stripHtml(raw.summary ?? ""),
    content: stripHtml(raw.content ?? raw.summary ?? ""),
    url: raw.url,
    source: raw.source,
    category: raw.category,
    publishedAt: raw.publishedAt || "",
    fetchedAt: new Date().toISOString(),
  };
  item.score = scoreNews(item);
  item.sourceWeight = sourceWeight(item.source);
  item.tags = classifyTags(item);
  return item;
}

function dedupe(items) {
  const seen = new Map();
  for (const item of items) {
    const key = `${item.url || ""}`.toLowerCase() || item.originalTitle.toLowerCase();
    const current = seen.get(key);
    if (!current || item.score > current.score) seen.set(key, item);
  }
  return [...seen.values()];
}

async function fetchBBC() {
  const feeds = [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://feeds.bbci.co.uk/news/technology/rss.xml",
  ];
  const all = [];
  for (const url of feeds) {
    try {
      all.push(...parseFeed(await fetchText(url), "BBC", "global"));
    } catch (error) {
      await appendLog("source_error", { source: "BBC", url, error: error.message });
    }
  }
  return all;
}

async function fetchGuardian() {
  const url =
    "https://content.guardianapis.com/search?api-key=test&show-fields=trailText,bodyText,headline&page-size=20&order-by=newest";
  try {
    const data = await fetchJson(url);
    return (data.response?.results ?? []).map(item => ({
      source: "Guardian",
      category: "global",
      originalTitle: item.webTitle || item.fields?.headline,
      summary: item.fields?.trailText || "",
      content: item.fields?.bodyText || item.fields?.trailText || "",
      url: item.webUrl,
      publishedAt: normalizeDate(item.webPublicationDate),
    }));
  } catch (error) {
    await appendLog("source_error", { source: "Guardian", url, error: error.message });
    return [];
  }
}

async function fetchGdelt() {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=(world%20OR%20economy%20OR%20technology%20OR%20policy)&mode=ArtList&format=json&maxrecords=30&sort=HybridRel";
  try {
    const data = await fetchJson(url);
    return (data.articles ?? []).map(item => ({
      source: "GDELT",
      category: "global",
      originalTitle: item.title,
      summary: item.seendate ? `GDELT 收录时间：${item.seendate}` : "",
      content: item.title,
      url: item.url,
      publishedAt: normalizeDate(item.seendate),
      domain: item.domain,
    }));
  } catch (error) {
    await appendLog("source_error", { source: "GDELT", url, error: error.message });
    return [];
  }
}

async function fetchHN() {
  try {
    const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json");
    const top = await Promise.all(
      ids.slice(0, 35).map(async id => {
        try {
          return await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        } catch {
          return null;
        }
      })
    );
    return top
      .filter(Boolean)
      .map(item => ({
        source: "Hacker News",
        category: "ai-tech",
        originalTitle: item.title,
        summary: `${item.score ?? 0} points · ${item.descendants ?? 0} comments`,
        content: item.text || `${item.score ?? 0} points · ${item.descendants ?? 0} comments`,
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        publishedAt: item.time ? new Date(item.time * 1000).toISOString() : "",
        points: item.score ?? 0,
      }));
  } catch (error) {
    await appendLog("source_error", { source: "Hacker News", error: error.message });
    return [];
  }
}

async function fetchProductHunt() {
  try {
    const xml = await fetchText("https://www.producthunt.com/feed");
    return parseFeed(xml, "Product Hunt", "ai-tech");
  } catch (error) {
    await appendLog("source_error", { source: "Product Hunt", error: error.message });
    return [];
  }
}

async function fetchTheVerge() {
  try {
    const xml = await fetchText("https://www.theverge.com/rss/index.xml");
    return parseFeed(xml, "The Verge", "ai-tech");
  } catch (error) {
    await appendLog("source_error", { source: "The Verge", error: error.message });
    return [];
  }
}

async function fetchHuggingFace() {
  const url = "https://huggingface.co/models?sort=trending";
  try {
    const html = await fetchText(url);
    const matches = [...html.matchAll(/href="\/([^"?#]+\/[^"?#]+)"[^>]*>\s*<[^>]*>\s*([^<]+?)\s*</g)];
    const items = [];
    for (const match of matches) {
      const repo = stripHtml(match[1]);
      if (!repo.includes("/") || repo.includes("models/")) continue;
      items.push({
        source: "Hugging Face",
        category: "ai-tech",
        originalTitle: repo,
        summary: "Hugging Face Trending Model",
        content: "该条目来自 Hugging Face 模型趋势页面，适合作为模型和 AI 应用观察信号。",
        url: `https://huggingface.co/${repo}`,
        publishedAt: "",
      });
      if (items.length >= 12) break;
    }
    return items;
  } catch (error) {
    await appendLog("source_error", { source: "Hugging Face", url, error: error.message });
    return [];
  }
}

async function translateItems(items) {
  if (!openaiConfig.apiKey) {
    return translateWithPublicEndpoint(items);
  }

  const batches = [];
  for (let index = 0; index < items.length; index += 10) batches.push(items.slice(index, index + 10));
  const translated = [];
  for (const batch of batches) {
    try {
      const payload = batch.map(item => ({
        id: item.id,
        source: item.source,
        category: item.category,
        title: item.originalTitle,
        summary: item.summary,
        content: item.content,
      }));
      const response = await fetch(`${openaiConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: openaiConfig.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "你是面向中文商业用户的信息分析编辑。请把英文新闻标题和摘要翻译成中文，并补充简洁判断。只输出 JSON。",
            },
            {
              role: "user",
              content: `请处理以下新闻条目。输出格式：{"items":[{"id":"","chineseTitle":"","chineseSummary":"","chineseContent":"","whyItMatters":""}]}。要求：中文标题准确自然；中文摘要 1-2 句；内容页正文 2-3 段，说明事件、背景、可能影响；whyItMatters 说明为什么值得关注。不要编造原文没有的具体数字。\n\n${JSON.stringify(payload)}`,
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const data = await response.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
      const map = new Map((parsed.items ?? []).map(item => [item.id, item]));
      translated.push(
        ...batch.map(item => ({
          ...item,
          ...(map.get(item.id) ?? {}),
          translationStatus: map.has(item.id) ? "translated" : "fallback",
        }))
      );
    } catch (error) {
      await appendLog("translation_error", { error: error.message });
      translated.push(
        ...batch.map(item => ({
          ...item,
          chineseTitle: item.originalTitle,
          chineseSummary: item.summary || "翻译服务暂不可用，已保留原始摘要。",
          chineseContent: item.content || item.summary || "翻译服务暂不可用，建议点击原文链接查看。",
          whyItMatters: "该条目已进入今日趋势池，后续可在翻译服务恢复后自动补全中文解读。",
          translationStatus: "fallback",
        }))
      );
    }
  }
  return translated;
}

async function translateTextPublic(text) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(value.slice(0, 1800))}`;
  const response = await fetchWithTimeout(url, {
    headers: { "User-Agent": userAgent },
    accept: "application/json",
  });
  const data = await response.json();
  return (data?.[0] ?? []).map(part => part?.[0] ?? "").join("").trim();
}

async function translateWithPublicEndpoint(items) {
  const translated = [];
  for (const item of items) {
    try {
      const [chineseTitle, chineseSummary, chineseContentBase] = await Promise.all([
        translateTextPublic(item.originalTitle),
        translateTextPublic(item.summary),
        translateTextPublic(item.content || item.summary),
      ]);
      const categoryReason =
        item.category === "ai-tech"
          ? "这条信息属于 AI 与科技趋势信号，适合用于观察工具选型、产品机会、开发者关注点和技术路线变化。"
          : "这条信息属于全球新闻信号，适合用于观察外部环境、政策变化、地缘风险和市场情绪。";
      translated.push({
        ...item,
        chineseTitle: chineseTitle || item.originalTitle,
        chineseSummary: chineseSummary || item.summary || "该条目暂未抓取到摘要，建议点击原文链接核对完整信息。",
        chineseContent:
          chineseContentBase ||
          chineseSummary ||
          item.summary ||
          "该条目暂未抓取到正文内容，建议点击原文链接核对完整信息。",
        whyItMatters: categoryReason,
        translationStatus: chineseTitle ? "translated" : "fallback",
      });
    } catch (error) {
      await appendLog("public_translation_error", { id: item.id, error: error.message });
      translated.push({
        ...item,
        chineseTitle: item.originalTitle,
        chineseSummary: item.summary || "翻译服务暂不可用，已保留原始摘要。",
        chineseContent: item.content || item.summary || "翻译服务暂不可用，建议点击原文链接查看。",
        whyItMatters: "该条目已进入今日趋势池，后续可在翻译服务恢复后自动补全中文解读。",
        translationStatus: "fallback",
      });
    }
  }
  return translated;
}

function pickTop(items, category, limit) {
  const sorted = items
    .filter(item => item.category === category)
    .sort((a, b) => b.score - a.score || b.sourceWeight - a.sourceWeight);
  const sourceCount = new Map();
  const sourceMax = category === "global" ? 8 : 7;
  const selected = [];
  for (const item of sorted) {
    const count = sourceCount.get(item.source) ?? 0;
    if (count >= sourceMax) continue;
    selected.push(item);
    sourceCount.set(item.source, count + 1);
    if (selected.length >= limit) break;
  }
  for (const item of sorted) {
    if (selected.some(selectedItem => selectedItem.id === item.id)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function main() {
  await ensureDirs();
  const sources = await Promise.all([
    fetchGdelt(),
    fetchBBC(),
    fetchGuardian(),
    fetchHN(),
    fetchProductHunt(),
    fetchHuggingFace(),
    fetchTheVerge(),
  ]);
  const normalized = dedupe(sources.flat().map(normalizeItem));
  const globalTop = pickTop(normalized, "global", globalLimit);
  const techTop = pickTop(normalized, "ai-tech", techLimit);
  const selected = await translateItems([...globalTop, ...techTop]);

  const selectedMap = new Map(selected.map(item => [item.id, item]));
  const globalIds = globalTop.map(item => item.id);
  const techIds = techTop.map(item => item.id);

  await Promise.all(
    selected.map(item =>
      writeFile(path.join(itemsDir, `${item.slug}.json`), JSON.stringify(selectedMap.get(item.id), null, 2))
    )
  );

  const report = {
    slug: today,
    date: today,
    title: `${today} 新闻趋势雷达`,
    description: "全球新闻 Top 20 与 AI 科技 Top 20 中文摘要。",
    generatedAt: new Date().toISOString(),
    stats: {
      totalItems: selected.length,
      globalItems: globalIds.length,
      techItems: techIds.length,
      translatedItems: selected.filter(item => item.translationStatus === "translated").length,
    },
    sections: {
      global: globalIds,
      aiTech: techIds,
    },
    sources: [...new Set(selected.map(item => item.source))],
    summary: {
      overview: `本期纳入 ${globalIds.length} 条全球新闻与 ${techIds.length} 条 AI 科技信号。`,
      conclusion: "建议把新闻模块作为趋势雷达的外部环境层，与 GitHub 项目趋势交叉观察。",
    },
  };
  await writeFile(path.join(reportsDir, `${today}.json`), JSON.stringify(report, null, 2));
  await appendLog("news_report_generated", {
    date: today,
    total: selected.length,
    global: globalIds.length,
    aiTech: techIds.length,
  });
  console.log(`Generated ${report.title}`);
  console.log(`Items: ${selected.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
