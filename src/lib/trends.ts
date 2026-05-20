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

function readJsonFiles<T>(folder: string): T[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(file => file.endsWith(".json"))
    .map(file => JSON.parse(readFileSync(path.join(folder, file), "utf8")) as T);
}

export function getTrendProjects() {
  return readJsonFiles<TrendProject>(path.join(dataRoot, "projects")).sort(
    (a, b) => b.stars - a.stars
  );
}

export function getTrendReports() {
  return readJsonFiles<TrendReport>(path.join(dataRoot, "reports")).sort(
    (a, b) => b.date.localeCompare(a.date)
  );
}

export function getXTrendReport(slug: string) {
  const file = path.join(dataRoot, "x", `${slug}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as XTrendReport;
}

export function getTrendProjectMap() {
  return new Map(getTrendProjects().map(project => [project.slug, project]));
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
