import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type SocialPlatform = "xiaohongshu" | "douyin" | "weibo";

export type SocialItem = {
  id: string;
  slug: string;
  platform: SocialPlatform;
  platformLabel: string;
  rank: number;
  title: string;
  summary: string;
  url: string;
  hotValue?: string;
  author?: string;
  publishedAt?: string;
  fetchedAt: string;
  tags: string[];
  source: string;
  sourceStatus: "live" | "cloakbrowser" | "fallback";
};

export type SocialReport = {
  slug: string;
  date: string;
  title: string;
  description: string;
  generatedAt: string;
  stats: {
    totalItems: number;
    xiaohongshuItems: number;
    douyinItems: number;
    weiboItems: number;
  };
  sections: Record<SocialPlatform, string[]>;
  sources: string[];
};

const dataRoot = path.join(process.cwd(), "src", "data", "social");
const itemRoot = path.join(dataRoot, "items");
const reportRoot = path.join(dataRoot, "reports");

const jsonFileCache = new Map<string, unknown>();
let socialItemsCache: SocialItem[] | null = null;
let socialReportsCache: SocialReport[] | null = null;

function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  const cached = jsonFileCache.get(file);
  if (cached) return cached as T;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as T;
  jsonFileCache.set(file, parsed);
  return parsed;
}

function readJsonFiles<T>(folder: string): T[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(file => file.endsWith(".json"))
    .map(file => readJsonFile<T>(path.join(folder, file)))
    .filter((item): item is T => Boolean(item));
}

export function getSocialItems() {
  if (!socialItemsCache) {
    socialItemsCache = readJsonFiles<SocialItem>(itemRoot).sort(
      (a, b) => a.platform.localeCompare(b.platform) || a.rank - b.rank
    );
  }
  return socialItemsCache;
}

export function getSocialReports() {
  if (!socialReportsCache) {
    socialReportsCache = readJsonFiles<SocialReport>(reportRoot).sort(
      (a, b) => b.date.localeCompare(a.date)
    );
  }
  return socialReportsCache;
}

export function getSocialItemBySlug(slug?: string) {
  if (!slug) return null;
  const direct = readJsonFile<SocialItem>(path.join(itemRoot, `${slug}.json`));
  if (direct) return direct;
  return getSocialItems().find(item => item.slug === slug) ?? null;
}

export function getSocialItemsByIds(ids: string[] = [], platform?: SocialPlatform) {
  return ids
    .map(id => {
      const item = readJsonFile<SocialItem>(path.join(itemRoot, `${id}.json`));
      return item && (!platform || item.platform === platform) ? item : null;
    })
    .filter((item): item is SocialItem => Boolean(item));
}

export function formatSocialDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function socialPlatformLabel(platform: SocialPlatform | string) {
  if (platform === "xiaohongshu") return "小红书";
  if (platform === "douyin") return "抖音";
  if (platform === "weibo") return "微博";
  return platform;
}
