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

function readJsonFiles<T>(folder: string): T[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(file => file.endsWith(".json"))
    .map(file => JSON.parse(readFileSync(path.join(folder, file), "utf8")) as T);
}

export function getNewsItems() {
  return readJsonFiles<NewsItem>(path.join(dataRoot, "items")).sort(
    (a, b) => b.score - a.score || b.sourceWeight - a.sourceWeight
  );
}

export function getNewsReports() {
  return readJsonFiles<NewsReport>(path.join(dataRoot, "reports")).sort(
    (a, b) => b.date.localeCompare(a.date)
  );
}

export function getNewsItemMap() {
  return new Map(getNewsItems().map(item => [item.id, item]));
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
