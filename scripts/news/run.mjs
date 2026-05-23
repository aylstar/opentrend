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
const financeLimit = Number.parseInt(process.env.NEWS_FINANCE_LIMIT ?? "30", 10);
const youtubeLimit = Number.parseInt(process.env.NEWS_YOUTUBE_LIMIT ?? "10", 10);
const sourceTimeoutMs = Number.parseInt(process.env.NEWS_FETCH_TIMEOUT_MS ?? "16000", 10);
const articleContentLimit = Number.parseInt(process.env.NEWS_ARTICLE_CONTENT_LIMIT ?? "6000", 10);
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const youtubeRegion = process.env.YOUTUBE_REGION ?? "US";

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

async function fetchArticleContent(item) {
  const existing = stripHtml(item.content ?? "");
  if (item.source === "YouTube") {
    return {
      ...item,
      content: existing || item.summary || item.originalTitle,
      contentStatus: existing ? "source-fulltext" : "summary-fallback",
    };
  }
  if (existing.length >= 800) {
    return { ...item, content: existing.slice(0, articleContentLimit), contentStatus: "source-fulltext" };
  }
  if (!/^https?:\/\//i.test(item.url ?? "")) {
    return { ...item, content: existing || item.summary || item.originalTitle, contentStatus: "no-url" };
  }
  try {
    const response = await fetchWithTimeout(item.url, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!/html|xml|text/i.test(contentType)) {
      return { ...item, content: existing || item.summary || item.originalTitle, contentStatus: "non-html" };
    }
    const html = await response.text();
    const articleText = extractArticleText(html);
    const fallback = existing || item.summary || item.originalTitle;
    const content = articleText.length > fallback.length + 80 ? articleText : fallback;
    return {
      ...item,
      content,
      contentStatus: articleText ? "article-extracted" : "summary-fallback",
    };
  } catch (error) {
    await appendLog("article_fetch_error", { id: item.id, source: item.source, url: item.url, error: error.message });
    return { ...item, content: existing || item.summary || item.originalTitle, contentStatus: "fetch-failed" };
  }
}

async function enrichArticleContent(items) {
  const enriched = [];
  const concurrency = Number.parseInt(process.env.NEWS_ARTICLE_CONCURRENCY ?? "4", 10);
  for (let index = 0; index < items.length; index += concurrency) {
    enriched.push(...(await Promise.all(items.slice(index, index + concurrency).map(fetchArticleContent))));
  }
  return enriched;
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
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
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

function normalizeText(value = "") {
  return decodeEntities(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMetaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripHtml(match[1]);
  }
  return "";
}

function extractJsonLdArticleBody(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(decodeEntities(script[1]).trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] ?? [])];
      for (const node of nodes.flat()) {
        if (!node || typeof node !== "object") continue;
        const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : node["@type"];
        if (/Article|NewsArticle|BlogPosting/i.test(String(type ?? "")) && node.articleBody) {
          return stripHtml(String(node.articleBody));
        }
      }
    } catch {
      // Publisher JSON-LD is often not strict JSON. Fall back to paragraph extraction.
    }
  }
  return "";
}

function extractArticleText(html) {
  const jsonLdBody = extractJsonLdArticleBody(html);
  if (jsonLdBody.length > 240) return normalizeText(jsonLdBody).slice(0, articleContentLimit);

  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const articleMatch =
    cleaned.match(/<article\b[\s\S]*?<\/article>/i) ??
    cleaned.match(/<main\b[\s\S]*?<\/main>/i) ??
    cleaned.match(/<body\b[\s\S]*?<\/body>/i);
  const scope = articleMatch?.[0] ?? cleaned;
  const paragraphMatches = [...scope.matchAll(/<(p|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const paragraphs = paragraphMatches
    .map(match => stripHtml(match[2]))
    .map(text => text.replace(/\s+/g, " ").trim())
    .filter(text => text.length >= 35)
    .filter(text => !/cookies?|newsletter|sign up|subscribe|advertisement|privacy policy|all rights reserved/i.test(text));
  const text = normalizeText([...new Set(paragraphs)].join("\n\n"));
  if (text.length > 240) return text.slice(0, articleContentLimit);

  const metaDescription =
    extractMetaContent(html, "article:body") ||
    extractMetaContent(html, "og:description") ||
    extractMetaContent(html, "description");
  return normalizeText(metaDescription).slice(0, articleContentLimit);
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

function cleanSourceTitle(value) {
  return stripHtml(value)
    .replace(/\s+[-–—]\s*(Bloomberg|Bloomberg\.com|bloomberg\.com|Reuters|Reuters\.com|The Verge|CNBC|MarketWatch)\s*$/i, "")
    .replace(/\s+\|\s*(Reuters|The Verge|CNBC|MarketWatch)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function polishChineseTitle(value, item = {}) {
  const source = item.source || "";
  const category = item.category || "";
  let title = String(value ?? "").trim();
  if (!title) return cleanSourceTitle(item.originalTitle ?? "");

  title = title
    .replace(/\s+[-–—]\s*(Bloomberg|Bloomberg\.com|bloomberg\.com|路透中文网|路透|Reuters|Reuters\.com)\s*$/i, "")
    .replace(/\s+\|\s*(路透|Reuters|The Verge|CNBC|MarketWatch)\s*$/i, "")
    .replace(/人工智能/g, "AI")
    .replace(/从AI到拦截器，乌克兰正在努力保护其天空的无人机安全/g, "乌克兰如何用 AI 与拦截器构建无人机防空网")
    .replace(/Google 的 AI正在被操纵。搜索巨头正在悄然反击/g, "Google 的 AI 正在被操纵，搜索巨头悄然反击")
    .replace(/Google 的 AI搜索太糟糕了，它可以“忽略”你正在寻找的内容/g, "Google AI 搜索失灵：甚至会忽略用户真正想找的内容")
    .replace(/高通的股价上涨表明投资者正在“觉醒”到AI设备的繁荣/g, "高通股价上涨显示投资者开始重估 AI 设备机会")
    .replace(/安全帽、AI和假流行病：一群前世界领导人正在努力拯救世界/g, "安全帽、AI 与假疫情：前世界领导人模拟全球危机应对")
    .replace(/谷歌反重力/g, "Google Antigravity")
    .replace(/十二南方?/g, "Twelve South")
    .replace(/万福玛丽项目/g, "《Project Hail Mary》")
    .replace(/主要收获/g, "核心要点")
    .replace(/股市原地踏步/g, "股市横盘")
    .replace(/诱饵和开关/g, "诱导式换壳")
    .replace(/银行老板在将员工描述为“低价值人力资本”后感到抱歉/g, "银行高管称员工为“低价值人力资本”后道歉")
    .replace(/解散 Live Nation-Ticketmaster/g, "拆分 Live Nation-Ticketmaster")
    .replace(/飓风智慧与说唱歌手机会/g, "Hurricane Wisdom 与 Chance the Rapper")
    .replace(/说唱歌手机会/g, "Chance the Rapper")
    .replace(/飓风智慧/g, "Hurricane Wisdom")
    .replace(/埃隆·马斯克 \(Elon Musk\)/g, "埃隆·马斯克")
    .replace(/凯文·沃什 \(Kevin Warsh\)/g, "凯文·沃什")
    .replace(/罗·卡纳 \(Ro Khanna\)/g, "罗·卡纳")
    .replace(/大卫·拉米 \(David Lammy\)/g, "大卫·拉米")
    .replace(/古兹曼·戈麦斯 \(Guzman y Gomez\)/g, "Guzman y Gomez")
    .replace(/Strategy创始人Michael Saylor/g, "Strategy 创始人 Michael Saylor")
    .replace(/Jim Cramer/g, "吉姆·克莱默")
    .replace(/Kevin Gordon/g, "凯文·戈登")
    .replace(/(?<=[\u4e00-\u9fff])AI/g, " AI")
    .replace(/AI(?=[\u4e00-\u9fff])/g, "AI ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (category === "youtube") {
    title = title
      .replace(/（官方音乐视频）/g, "（官方 MV）")
      .replace(/\\|/g, " | ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  if (/^[A-Za-z0-9\s:'’.,!?()&|/\\-–—]+$/.test(title) && category !== "youtube" && source !== "Product Hunt") {
    return cleanSourceTitle(item.originalTitle ?? title);
  }
  return title;
}

function scoreNews(item) {
  let score = 50;
  const text = `${item.originalTitle} ${item.summary}`.toLowerCase();
  if (/breaking|live|war|election|policy|rate|ai|openai|nvidia|model|security/.test(text)) score += 12;
  if (/market|stock|bond|yield|fed|inflation|earnings|bank|oil|gold|dollar|tariff|debt/.test(text)) score += 10;
  if (/analysis|explainer|exclusive|investigation/.test(text)) score += 8;
  if (item.source === "GDELT") score += 6;
  if (item.source === "BBC" || item.source === "Guardian") score += 5;
  if (item.source === "Hacker News") score += Math.min(20, Math.round((item.points ?? 0) / 80));
  if (item.source === "Product Hunt") score += 7;
  if (item.source === "YouTube") score += Math.min(25, Math.round(Math.log10(Math.max(1, item.viewCount ?? 1)) * 4));
  if (item.category === "finance") score += 8;
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
    ["财经", ["finance", "markets", "stocks", "bonds", "yield", "earnings", "oil", "gold", "dollar"]],
    ["安全", ["security", "cyber", "privacy", "hack", "breach"]],
    ["产品", ["product", "launch", "tool", "founder"]],
    ["视频", ["video", "youtube", "views", "channel"]],
  ];
  for (const [tag, keywords] of rules) {
    if (keywords.some(keyword => text.includes(keyword))) tags.add(tag);
  }
  if (!tags.size) tags.add(item.category === "ai-tech" ? "科技" : item.category === "youtube" ? "视频" : item.category === "finance" ? "财经" : "全球");
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
    YouTube: 78,
    Bloomberg: 95,
    Reuters: 94,
    "Financial Times": 93,
    "Wall Street Journal": 92,
    CNBC: 88,
    MarketWatch: 84,
    "Yahoo Finance": 82,
    Investing: 80,
  }[source] ?? 60;
}

function normalizeItem(raw) {
  const item = {
    ...raw,
    id: stableId(raw),
    slug: stableId(raw),
    originalTitle: cleanSourceTitle(raw.originalTitle),
    summary: stripHtml(raw.summary ?? ""),
    content: stripHtml(raw.content ?? raw.summary ?? ""),
    url: raw.url,
    source: raw.source,
    category: raw.category,
    publishedAt: raw.publishedAt || "",
    fetchedAt: new Date().toISOString(),
    viewCount: raw.viewCount,
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

async function fetchYouTube() {
  if (!youtubeApiKey) {
    await appendLog("source_skipped", {
      source: "YouTube",
      reason: "YOUTUBE_API_KEY is not configured",
    });
    return [];
  }
  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&chart=mostPopular&maxResults=${youtubeLimit}` +
    `&regionCode=${encodeURIComponent(youtubeRegion)}&key=${encodeURIComponent(youtubeApiKey)}`;
  try {
    const data = await fetchJson(url);
    return (data.items ?? []).map(item => {
      const snippet = item.snippet ?? {};
      const statistics = item.statistics ?? {};
      const viewCount = Number.parseInt(statistics.viewCount ?? "0", 10);
      return {
        source: "YouTube",
        category: "youtube",
        originalTitle: snippet.title,
        summary: `${snippet.channelTitle ?? "Unknown channel"} · ${Number.isFinite(viewCount) ? viewCount.toLocaleString("en-US") : "0"} views`,
        content:
          snippet.description ||
          `${snippet.title}\n\nChannel: ${snippet.channelTitle ?? "Unknown channel"}\nViews: ${Number.isFinite(viewCount) ? viewCount.toLocaleString("en-US") : "0"}`,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        publishedAt: normalizeDate(snippet.publishedAt),
        channelTitle: snippet.channelTitle,
        viewCount: Number.isFinite(viewCount) ? viewCount : 0,
      };
    });
  } catch (error) {
    await appendLog("source_error", { source: "YouTube", region: youtubeRegion, error: error.message });
    return [];
  }
}

async function fetchFinanceFeeds() {
  const feeds = [
    {
      source: "Yahoo Finance",
      url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,^IXIC,^DJI&region=US&lang=en-US",
    },
    { source: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
    { source: "CNBC", url: "https://www.cnbc.com/id/10001147/device/rss/rss.html" },
    { source: "MarketWatch", url: "https://www.marketwatch.com/rss/topstories" },
    { source: "MarketWatch", url: "https://www.marketwatch.com/rss/marketpulse" },
    { source: "Wall Street Journal", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
    { source: "Wall Street Journal", url: "https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml" },
    { source: "Investing", url: "https://www.investing.com/rss/news.rss" },
    { source: "Investing", url: "https://www.investing.com/rss/market_overview.rss" },
    { source: "Financial Times", url: "https://www.ft.com/rss/home" },
    {
      source: "Bloomberg",
      url: "https://news.google.com/rss/search?q=site%3Abloomberg.com%20markets%20OR%20site%3Abloomberg.com%20finance&hl=en-US&gl=US&ceid=US%3Aen",
    },
    {
      source: "Reuters",
      url: "https://news.google.com/rss/search?q=site%3Areuters.com%20markets%20OR%20site%3Areuters.com%20business&hl=en-US&gl=US&ceid=US%3Aen",
    },
  ];
  const all = [];
  for (const feed of feeds) {
    try {
      const items = parseFeed(await fetchText(feed.url), feed.source, "finance");
      all.push(...items);
    } catch (error) {
      await appendLog("source_error", { source: feed.source, url: feed.url, error: error.message });
    }
  }
  return all;
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
                "你是面向中文商业用户的信息分析编辑。请把英文新闻标题和摘要改写为准确、自然、可用于商业新闻网站的中文标题与正文。只输出 JSON。",
            },
            {
              role: "user",
              content: `请处理以下新闻条目。输出格式：{"items":[{"id":"","chineseTitle":"","chineseSummary":"","chineseContent":"","whyItMatters":""}]}。

标题翻译要求：
1. 标题不是逐字直译，要按中文商业新闻标题重写，准确、短、自然。
2. 删除来源尾缀，例如 Bloomberg.com、Reuters、The Verge、CNBC，不要写进中文标题。
3. 公司、产品、艺名、项目名优先保留英文原名，例如 Twelve South、Google Antigravity、Chance the Rapper、Live Nation-Ticketmaster、Product Hunt 产品名；除非中文世界已有稳定译名。
4. 不要把品牌或人名硬翻成中文，例如不要把 Twelve South 翻成“十二南”，不要把 Chance the Rapper 翻成“说唱歌手机会”。
5. 常见新闻表达要意译：takeaways 译为“核心要点”；tread water 译为“横盘”；bait and switch 译为“诱导式换壳/先诱导后变卦”；sorry after describing 译为“称...后道歉”。
6. 财经标题要使用专业表达，例如 “yield” 根据语境译为“收益率”，“buyout bankers” 可译为“并购融资银行家”，“debt pre-sales” 可译为“债务融资预售/提前配售”。
7. YouTube 音乐、影视、游戏标题中，艺人名和作品名一般保留原文，只翻译 Official Video、Trailer、Music Video 等类型说明。

中文摘要 1-2 句；内容页正文 2-3 段，说明事件、背景、可能影响；whyItMatters 说明为什么值得关注。不要编造原文没有的具体数字。\n\n${JSON.stringify(payload)}`,
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
          chineseTitle: polishChineseTitle(map.get(item.id)?.chineseTitle, item),
          translationStatus: map.has(item.id) ? "translated" : "fallback",
        }))
      );
    } catch (error) {
      await appendLog("translation_error", { error: error.message });
      translated.push(
        ...batch.map(item => ({
          ...item,
          chineseTitle: polishChineseTitle(item.originalTitle, item),
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

async function translateLongTextPublic(text) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  const chunks = [];
  let current = "";
  for (const paragraph of value.split(/\n+/).map(item => item.trim()).filter(Boolean)) {
    if ((current + "\n\n" + paragraph).length > 1700) {
      if (current) chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  if (!chunks.length) {
    for (let index = 0; index < value.length; index += 1700) chunks.push(value.slice(index, index + 1700));
  }
  const translated = [];
  for (const chunk of chunks.slice(0, 4)) {
    translated.push(await translateTextPublic(chunk));
  }
  return translated.filter(Boolean).join("\n\n").trim();
}

async function translateWithPublicEndpoint(items) {
  const translated = [];
  for (const item of items) {
    try {
      const [chineseTitle, chineseSummary, chineseContentBase] = await Promise.all([
        translateTextPublic(item.originalTitle),
        translateTextPublic(item.summary),
        translateLongTextPublic(item.content || item.summary),
      ]);
      const categoryReason =
        item.category === "ai-tech"
          ? "这条信息属于 AI 与科技趋势信号，适合用于观察工具选型、产品机会、开发者关注点和技术路线变化。"
          : item.category === "youtube"
            ? "这条信息属于 YouTube 热门视频信号，适合用于观察大众注意力、内容叙事、传播主题和跨平台选题机会。"
            : item.category === "finance"
              ? "这条信息属于财经市场信号，适合用于观察利率、汇率、股债商品、金融机构和宏观政策变化。"
              : "这条信息属于全球新闻信号，适合用于观察外部环境、政策变化、地缘风险和市场情绪。";
      translated.push({
        ...item,
        chineseTitle: polishChineseTitle(chineseTitle || item.originalTitle, item),
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
        chineseTitle: polishChineseTitle(item.originalTitle, item),
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
  const sourceMax = category === "global" ? 8 : category === "youtube" ? 10 : category === "finance" ? 6 : 7;
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
    fetchFinanceFeeds(),
    fetchYouTube(),
  ]);
  const normalized = dedupe(sources.flat().map(normalizeItem));
  const globalTop = pickTop(normalized, "global", globalLimit);
  const techTop = pickTop(normalized, "ai-tech", techLimit);
  const financeTop = pickTop(normalized, "finance", financeLimit);
  const youtubeTop = pickTop(normalized, "youtube", youtubeLimit);
  const withArticleContent = await enrichArticleContent([...globalTop, ...techTop, ...financeTop, ...youtubeTop]);
  const selected = await translateItems(withArticleContent);

  const selectedMap = new Map(selected.map(item => [item.id, item]));
  const globalIds = globalTop.map(item => item.id);
  const techIds = techTop.map(item => item.id);
  const financeIds = financeTop.map(item => item.id);
  const youtubeIds = youtubeTop.map(item => item.id);

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
      financeItems: financeIds.length,
      youtubeItems: youtubeIds.length,
      translatedItems: selected.filter(item => item.translationStatus === "translated").length,
    },
    sections: {
      global: globalIds,
      aiTech: techIds,
      finance: financeIds,
      youtube: youtubeIds,
    },
    sources: [...new Set(selected.map(item => item.source))],
    summary: {
      overview: `本期纳入 ${globalIds.length} 条全球新闻、${techIds.length} 条 AI 科技信号、${financeIds.length} 条财经市场信号与 ${youtubeIds.length} 条 YouTube 热门视频。`,
      conclusion: "建议把新闻模块作为外部环境层，把财经雷达作为市场变量层，把 YouTube 热门视频作为大众注意力层，与 GitHub 项目趋势交叉观察。",
    },
  };
  await writeFile(path.join(reportsDir, `${today}.json`), JSON.stringify(report, null, 2));
  await appendLog("news_report_generated", {
    date: today,
    total: selected.length,
    global: globalIds.length,
    aiTech: techIds.length,
    finance: financeIds.length,
    youtube: youtubeIds.length,
  });
  console.log(`Generated ${report.title}`);
  console.log(`Items: ${selected.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
