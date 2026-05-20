import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const xDataDir = path.join(rootDir, "src", "data", "trends", "x");
const token = process.env.X_BEARER_TOKEN;
const maxPosts = Number.parseInt(process.env.X_TREND_MAX_POSTS ?? "30", 10);
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const defaultRegions = [
  ["global", "全球", 1],
  ["us", "美国", 23424977],
  ["japan", "日本", 23424856],
  ["singapore", "新加坡", 23424948],
  ["hongkong", "中国香港", 24865698],
];

const regions = (process.env.X_TREND_REGIONS ?? "")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean)
  .map(item => {
    const [id, label, woeid] = item.split(":");
    return [id, label, Number.parseInt(woeid, 10)];
  });

const targetRegions = regions.length ? regions : defaultRegions;

function headers() {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "open-qiyuebao-x-trend",
  };
}

async function xFetch(url, params = {}) {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") requestUrl.searchParams.set(key, String(value));
  }
  const response = await fetch(requestUrl, { headers: headers() });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

async function fetchTopicsByWoeid(woeid) {
  const data = await xFetch(`https://api.x.com/2/trends/by/woeid/${woeid}`);
  return (data.data ?? [])
    .map(item => item.trend_name ?? item.name ?? "")
    .filter(Boolean)
    .slice(0, 8);
}

async function searchPosts(topic) {
  const query = `${topic} -is:retweet lang:en`;
  const data = await xFetch("https://api.x.com/2/tweets/search/recent", {
    query,
    max_results: 10,
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username,name",
  });
  const users = new Map((data.includes?.users ?? []).map(user => [user.id, user]));
  return (data.data ?? []).map(tweet => {
    const user = users.get(tweet.author_id);
    const metrics = tweet.public_metrics ?? {};
    const score =
      (metrics.like_count ?? 0) +
      (metrics.retweet_count ?? 0) * 3 +
      (metrics.reply_count ?? 0) * 2 +
      (metrics.quote_count ?? 0) * 2;
    return {
      id: tweet.id,
      title: tweet.text.replace(/\s+/g, " ").slice(0, 80),
      author: user?.username ? `@${user.username}` : tweet.author_id,
      url: user?.username ? `https://x.com/${user.username}/status/${tweet.id}` : `https://x.com/i/web/status/${tweet.id}`,
      text: tweet.text,
      topic,
      createdAt: tweet.created_at,
      score,
      metrics: {
        reposts: metrics.retweet_count ?? 0,
        likes: metrics.like_count ?? 0,
        replies: metrics.reply_count ?? 0,
        quotes: metrics.quote_count ?? 0,
      },
    };
  });
}

async function fetchRegion([id, label, woeid]) {
  const topics = await fetchTopicsByWoeid(woeid);
  const postMap = new Map();
  for (const topic of topics) {
    try {
      const posts = await searchPosts(topic);
      for (const post of posts) {
        const previous = postMap.get(post.id);
        if (!previous || post.score > previous.score) postMap.set(post.id, post);
      }
    } catch (error) {
      console.warn(`search failed for ${label}/${topic}: ${error.message}`);
    }
  }
  const posts = [...postMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPosts)
    .map((post, index) => ({
      id: post.id,
      rank: index + 1,
      title: post.title,
      author: post.author,
      url: post.url,
      text: post.text,
      metrics: post.metrics,
      topic: post.topic,
      createdAt: post.createdAt,
    }));

  return {
    id,
    label,
    woeid,
    posts,
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!token) {
    throw new Error("X_BEARER_TOKEN is required to fetch X trends.");
  }
  await mkdir(xDataDir, { recursive: true });
  const regions = [];
  for (const region of targetRegions) {
    regions.push(await fetchRegion(region));
  }

  const report = {
    slug: today,
    date: today,
    title: `${today} X 热门帖报告`,
    regions,
    updatedAt: new Date().toISOString(),
  };

  await writeFile(path.join(xDataDir, `${today}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`X trend report generated: ${today}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
