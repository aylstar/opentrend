import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type TrendAnalysis = {
  oneLine: string;
  problem: string;
  audience: string;
  scenarios: string[];
  detailParagraphs?: string[];
  interpretation: string;
  installRequirements: string;
  installGuide: string;
  deployment: string;
  commercialValue: string;
  efficiencyValue: string;
  learningValue: string;
  reuseValue: string;
  chinaNotes: string;
  risk: string;
  recommendation: number;
  tags: string[];
};

export type TrendProject = {
  slug: string;
  owner: string;
  repo: string;
  name: string;
  fullName: string;
  description: string;
  language: string;
  githubUrl: string;
  docsUrl: string;
  nasUrl?: string;
  nasSyncedAt?: string;
  nasArchiveSize?: number;
  stars: number;
  forks: number;
  openIssues: number;
  license: string;
  pushedAt: string;
  updatedAt: string;
  createdAt: string;
  archived: boolean;
  trendWindows: string[];
  tags: string[];
  recommendation: number;
  readmeExcerpt: string;
  firstSeenAt: string;
  generatedAt: string;
  analysis: TrendAnalysis;
};

export type TrendReport = {
  slug: string;
  date: string;
  title: string;
  description: string;
  generatedAt: string;
  stats: {
    totalProjects: number;
    weeklyProjects: number;
    monthlyProjects: number;
    averageRecommendation: number;
  };
  sections: {
    recommended: string[];
    weekly: string[];
    monthly: string[];
    commercial: string[];
    deployable: string[];
    risky: string[];
  };
  summary: {
    overview: string;
    conclusion: string;
  };
  projectSlugs: string[];
};

export type XTrendPost = {
  id: string;
  rank: number;
  title: string;
  author: string;
  url: string;
  text: string;
  metrics?: {
    reposts?: number;
    likes?: number;
    replies?: number;
    quotes?: number;
  };
  topic?: string;
  createdAt?: string;
};

export type XTrendRegion = {
  id: string;
  label: string;
  woeid?: number;
  posts: XTrendPost[];
  updatedAt?: string;
};

export type XTrendReport = {
  slug: string;
  date: string;
  title: string;
  regions: XTrendRegion[];
  updatedAt: string;
};

const dataRoot = path.join(process.cwd(), "src", "data", "trends");
const projectRoot = path.join(dataRoot, "projects");
const reportRoot = path.join(dataRoot, "reports");

const jsonFileCache = new Map<string, unknown>();
let trendProjectsCache: TrendProject[] | null = null;
let trendReportsCache: TrendReport[] | null = null;

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

export function getTrendProjects() {
  if (!trendProjectsCache) {
    trendProjectsCache = readJsonFiles<TrendProject>(projectRoot).sort(
      (a, b) => b.stars - a.stars
    );
  }
  return trendProjectsCache;
}

export function getTrendReports() {
  if (!trendReportsCache) {
    trendReportsCache = readJsonFiles<TrendReport>(reportRoot).sort(
      (a, b) => b.date.localeCompare(a.date)
    );
  }
  return trendReportsCache;
}

export function getXTrendReport(slug: string) {
  const file = path.join(dataRoot, "x", `${slug}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as XTrendReport;
}

export function getTrendProjectMap() {
  return new Map(getTrendProjects().map(project => [project.slug, project]));
}

export function getTrendProjectBySlug(slug?: string) {
  if (!slug) return null;
  return readJsonFile<TrendProject>(path.join(projectRoot, `${slug}.json`)) ??
    getTrendProjects().find(project => project.slug === slug) ??
    null;
}

export function getTrendProjectsBySlugs(slugs: string[] = []) {
  return slugs
    .map(slug => getTrendProjectBySlug(slug))
    .filter((project): project is TrendProject => Boolean(project));
}

export function formatTrendDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function windowLabel(window: string) {
  if (window === "weekly") return "周榜";
  if (window === "monthly") return "月榜";
  return window;
}
