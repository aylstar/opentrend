import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "src", "data", "social");
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
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const sourceTimeoutMs = Number.parseInt(process.env.SOCIAL_FETCH_TIMEOUT_MS ?? "18000", 10);
const hotApiBase = (process.env.SOCIAL_HOT_API_BASE ?? "https://api-hot.imsyy.top").replace(/\/$/, "");
const uapiBase = (process.env.SOCIAL_UAPI_BASE ?? "https://uapis.cn/api/v1/misc/hotboard").replace(/\/$/, "");
const rednoteApi = process.env.SOCIAL_REDNOTE_API ?? "https://60s.viki.moe/v2/rednote";
const cloakbrowserExport = process.env.CLOAKBROWSER_SOCIAL_EXPORT ?? process.env.SOCIAL_CLOAKBROWSER_EXPORT;

const platforms = {
  xiaohongshu: {
    label: "小红书",
    limit: Number.parseInt(process.env.SOCIAL_XIAOHONGSHU_LIMIT ?? "50", 10),
    homepage: "https://www.xiaohongshu.com",
  },
  douyin: {
    label: "抖音",
    limit: Number.parseInt(process.env.SOCIAL_DOUYIN_LIMIT ?? "100", 10),
    homepage: "https://www.douyin.com",
  },
  weibo: {
    label: "微博",
    limit: Number.parseInt(process.env.SOCIAL_WEIBO_LIMIT ?? "100", 10),
    homepage: "https://s.weibo.com/top/summary/",
  },
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
  await writeFile(path.join(logsDir, "social_logs.jsonl"), line, { flag: "a" });
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
        Accept: "application/json,text/plain,*/*",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-json response from ${url}: ${text.slice(0, 120)}`);
  }
}

function hash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatHotValue(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number >= 10000) return `${Math.round(number / 10000).toLocaleString()}万热度`;
  return `${number.toLocaleString()}热度`;
}

function buildItem(platform, raw, index, source, sourceStatus = "live") {
  const config = platforms[platform];
  const title = cleanText(raw.title ?? raw.word ?? raw.name ?? raw.desc ?? `热点 ${index + 1}`);
  const id = `${platform}-${hash(`${today}-${title}-${raw.url ?? ""}`)}`;
  const slug = `${platform}-${slugify(title) || hash(title)}`;
  const url =
    raw.url ||
    raw.mobileUrl ||
    raw.link ||
    (platform === "weibo"
      ? `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`
      : platform === "douyin"
        ? `https://www.douyin.com/search/${encodeURIComponent(title)}`
        : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(title)}`);
  const hotValue = formatHotValue(raw.hot ?? raw.hotValue ?? raw.hot_value ?? raw.score);
  return {
    id,
    slug,
    platform,
    platformLabel: config.label,
    rank: index + 1,
    title,
    summary:
      cleanText(raw.summary ?? raw.desc) ||
      `${config.label}热榜第 ${index + 1} 位：${title}${hotValue ? `，当前热度为 ${hotValue}` : ""}。`,
    url,
    hotValue,
    author: cleanText(raw.author ?? raw.user ?? raw.nickname),
    publishedAt: raw.publishedAt ?? raw.timestamp ?? "",
    fetchedAt: new Date().toISOString(),
    tags: [config.label, "社媒热榜", "每日趋势"],
    source,
    sourceStatus,
  };
}

function normaliseHotApiPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.list)) return payload.list;
  return [];
}

async function fetchFromUapi(platform) {
  if (platform === "xiaohongshu") return [];
  const url = `${uapiBase}?type=${platform}`;
  const payload = await fetchJson(url);
  const rows = normaliseHotApiPayload(payload);
  if (!rows.length) return [];
  await appendLog("source_ok", { platform, source: "UAPI Hotboard", url, count: rows.length });
  return rows.map((row, index) =>
    buildItem(
      platform,
      {
        title: row.title,
        hot: row.hot_value ?? row.hot,
        url: row.url,
        summary: row.desc,
        timestamp: payload.update_time,
      },
      index,
      "UAPI Hotboard"
    )
  );
}

async function fetchRednote60s() {
  const payload = await fetchJson(rednoteApi);
  const rows = normaliseHotApiPayload(payload);
  if (!rows.length) return [];
  await appendLog("source_ok", { platform: "xiaohongshu", source: "60s API Rednote", url: rednoteApi, count: rows.length });
  return rows.map((row, index) =>
    buildItem(
      "xiaohongshu",
      {
        title: row.title,
        hot: row.score,
        url: row.link,
        summary: row.word_type ? `${row.title}，小红书热榜标记：${row.word_type}。` : "",
      },
      index,
      "60s API Rednote"
    )
  );
}

async function fetchFromHotApi(platform) {
  const urls = [
    `${hotApiBase}/${platform}`,
    `${hotApiBase}/api/${platform}`,
  ];
  for (const url of urls) {
    try {
      const payload = await fetchJson(url);
      const rows = normaliseHotApiPayload(payload);
      if (rows.length) {
        await appendLog("source_ok", { platform, source: "DailyHotApi", url, count: rows.length });
        return rows.map((row, index) => buildItem(platform, row, index, "DailyHotApi"));
      }
    } catch (error) {
      await appendLog("source_error", { platform, source: "DailyHotApi", url, error: error.message });
    }
  }
  return [];
}

async function fetchDouyinOfficial() {
  const url =
    "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1";
  const payload = await fetchJson(url, {
    headers: {
      Referer: "https://www.douyin.com/",
    },
  });
  const rows = payload?.data?.word_list ?? payload?.word_list ?? [];
  await appendLog("source_ok", { platform: "douyin", source: "Douyin Web", url, count: rows.length });
  return rows.map((row, index) =>
    buildItem(
      "douyin",
      {
        title: row.word,
        hot: row.hot_value,
        url: row.sentence_id ? `https://www.douyin.com/hot/${row.sentence_id}` : undefined,
        timestamp: row.event_time,
      },
      index,
      "Douyin Web"
    )
  );
}

async function fetchWeiboOfficial() {
  const url = "https://weibo.com/ajax/side/hotSearch";
  const payload = await fetchJson(url, {
    headers: {
      Referer: "https://weibo.com/",
    },
  });
  const rows = payload?.data?.realtime ?? [];
  await appendLog("source_ok", { platform: "weibo", source: "Weibo Web", url, count: rows.length });
  return rows.map((row, index) =>
    buildItem(
      "weibo",
      {
        title: row.word || row.word_scheme,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(row.word || row.word_scheme || "")}`,
        timestamp: row.onboard_time,
      },
      index,
      "Weibo Web"
    )
  );
}

async function fetchFromCloakbrowserExport(platform) {
  if (!cloakbrowserExport) return [];
  try {
    const parsed = JSON.parse(await readFile(cloakbrowserExport, "utf8"));
    const rows = Array.isArray(parsed?.[platform]) ? parsed[platform] : [];
    if (!rows.length) return [];
    await appendLog("source_ok", { platform, source: "CloakBrowser Export", count: rows.length });
    return rows.map((row, index) => buildItem(platform, row, index, "CloakBrowser Export", "cloakbrowser"));
  } catch (error) {
    await appendLog("source_error", {
      platform,
      source: "CloakBrowser Export",
      file: cloakbrowserExport,
      error: error.message,
    });
    return [];
  }
}

function fallbackItems(platform) {
  const config = platforms[platform];
  const rows = Array.from({ length: Math.min(10, config.limit) }, (_, index) => ({
    title: `${config.label}热榜抓取源待恢复 ${index + 1}`,
    summary:
      `${config.label}自动抓取源本次未返回可用数据。请优先配置 SOCIAL_HOT_API_BASE，或使用 CloakBrowser 导出文件接入登录态抓取结果。`,
    url: config.homepage,
  }));
  return rows.map((row, index) => buildItem(platform, row, index, "Fallback", "fallback"));
}

async function fetchPlatform(platform) {
  const sourceChain = [
    () => fetchFromUapi(platform),
    () => fetchFromHotApi(platform),
    () => fetchFromCloakbrowserExport(platform),
  ];
  if (platform === "xiaohongshu") sourceChain.unshift(fetchRednote60s);
  if (platform === "douyin") sourceChain.splice(1, 0, fetchDouyinOfficial);
  if (platform === "weibo") sourceChain.splice(1, 0, fetchWeiboOfficial);

  for (const fetcher of sourceChain) {
    try {
      const items = await fetcher();
      if (items.length) return items.slice(0, platforms[platform].limit);
    } catch (error) {
      await appendLog("source_error", { platform, error: error.message });
    }
  }
  await appendLog("source_fallback", { platform });
  return fallbackItems(platform);
}

async function writeItem(item) {
  await writeFile(path.join(itemsDir, `${item.id}.json`), JSON.stringify(item, null, 2));
}

async function main() {
  await ensureDirs();
  const [xiaohongshu, douyin, weibo] = await Promise.all([
    fetchPlatform("xiaohongshu"),
    fetchPlatform("douyin"),
    fetchPlatform("weibo"),
  ]);
  const allItems = [...xiaohongshu, ...douyin, ...weibo];
  await Promise.all(allItems.map(writeItem));

  const report = {
    slug: today,
    date: today,
    title: `${today} 社媒雷达日报`,
    description: "小红书、抖音、微博每日热榜聚合。",
    generatedAt: new Date().toISOString(),
    stats: {
      totalItems: allItems.length,
      xiaohongshuItems: xiaohongshu.length,
      douyinItems: douyin.length,
      weiboItems: weibo.length,
    },
    sections: {
      xiaohongshu: xiaohongshu.map(item => item.id),
      douyin: douyin.map(item => item.id),
      weibo: weibo.map(item => item.id),
    },
    sources: [...new Set(allItems.map(item => item.source))],
  };

  await writeFile(path.join(reportsDir, `${today}.json`), JSON.stringify(report, null, 2));
  await appendLog("social_report_generated", { date: today, stats: report.stats, sources: report.sources });
  console.log(`Generated ${report.title}`);
  console.log(`Social items: ${report.stats.totalItems}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
