import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type NewsItem = {
  id: string;
  slug: string;
  rank: number;
  source: string;
  category: "global" | "ai-tech" | "finance" | "youtube";
  originalTitle: string;
  chineseTitle: string;
  summary: string;
  chineseSummary: string;
  content: string;
  contentStatus?: "source-fulltext" | "article-extracted" | "summary-fallback" | "fetch-failed" | "non-html" | "no-url";
  chineseContent: string;
  whyItMatters: string;
  url: string;
  publishedAt: string;
  fetchedAt: string;
  score: number;
  sourceWeight: number;
  viewCount?: number;
  tags: string[];
  translationStatus: "translated" | "fallback";
};

export type NewsReport = {
  slug: string;
  date: string;
  title: string;
  description: string;
  generatedAt: string;
  stats: {
    totalItems: number;
    globalItems: number;
    techItems: number;
    financeItems?: number;
    youtubeItems?: number;
    translatedItems: number;
  };
  sections: {
    global: string[];
    aiTech: string[];
    finance?: string[];
    youtube?: string[];
  };
  sources: string[];
  summary: {
    overview: string;
    conclusion: string;
  };
};

const dataRoot = path.join(process.cwd(), "src", "data", "news");
const itemRoot = path.join(dataRoot, "items");
const reportRoot = path.join(dataRoot, "reports");

const jsonFileCache = new Map<string, unknown>();
let newsItemsCache: NewsItem[] | null = null;
let newsReportsCache: NewsReport[] | null = null;

function readJsonFiles<T>(folder: string): T[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(file => file.endsWith(".json"))
    .map(file => readJsonFile<T>(path.join(folder, file)))
    .filter((item): item is T => Boolean(item));
}

function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  const cached = jsonFileCache.get(file);
  if (cached) return cached as T;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as T;
  jsonFileCache.set(file, parsed);
  return parsed;
}

export function getNewsItems() {
  if (!newsItemsCache) {
    newsItemsCache = readJsonFiles<NewsItem>(itemRoot).sort(
      (a, b) => b.score - a.score || b.sourceWeight - a.sourceWeight
    );
  }
  return newsItemsCache;
}

export function getNewsReports() {
  if (!newsReportsCache) {
    newsReportsCache = readJsonFiles<NewsReport>(reportRoot).sort(
      (a, b) => b.date.localeCompare(a.date)
    );
  }
  return newsReportsCache;
}

export function getNewsItemMap() {
  return new Map(getNewsItems().map(item => [item.id, item]));
}

export function getNewsItemBySlug(slug?: string, category?: NewsItem["category"]) {
  if (!slug) return null;
  const direct = readJsonFile<NewsItem>(path.join(itemRoot, `${slug}.json`));
  if (direct && (!category || direct.category === category)) return direct;
  return getNewsItems().find(item => item.slug === slug && (!category || item.category === category)) ?? null;
}

export function getNewsItemsByIds(ids: string[] = [], category?: NewsItem["category"]) {
  return ids
    .map(id => {
      const item = readJsonFile<NewsItem>(path.join(itemRoot, `${id}.json`));
      return item && (!category || item.category === category) ? item : null;
    })
    .filter((item): item is NewsItem => Boolean(item));
}

export function formatNewsDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function newsCategoryLabel(category: string) {
  if (category === "global") return "全球新闻";
  if (category === "ai-tech") return "AI 科技";
  if (category === "finance") return "财经市场";
  if (category === "youtube") return "YouTube 热门";
  return category;
}
