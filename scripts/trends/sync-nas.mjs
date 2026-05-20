import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";

const rootDir = process.cwd();
const projectsDir = path.join(rootDir, "src", "data", "trends", "projects");
const cacheDir = path.join(rootDir, ".cache", "trend-archives");

const nasDir = process.env.TREND_NAS_DIR;
const publicBaseUrl = process.env.TREND_NAS_PUBLIC_BASE_URL;
const retentionDays = Number.parseInt(process.env.TREND_NAS_RETENTION_DAYS ?? "30", 10);
const maxProjects = Number.parseInt(process.env.TREND_NAS_MAX_PROJECTS ?? "20", 10);
const archiveDate =
  process.env.TREND_NAS_ARCHIVE_DATE ??
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const githubHeaders = {
  "User-Agent": "open-qiyuebao-nas-sync",
  Accept: "application/vnd.github+json",
};

if (process.env.GITHUB_TOKEN) {
  githubHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

function requiredEnv(name, value) {
  if (!value) {
    throw new Error(`${name} is required. Example: ${name}=/Volumes/nas/opentrend`);
  }
}

function joinUrl(...parts) {
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? String(part).replace(/\/+$/, "") : String(part).replace(/^\/+|\/+$/g, "")
    )
    .join("/");
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withRetry(label, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const waitMs = 800 * attempt;
        console.warn(`${label} failed, retry ${attempt}/${attempts - 1}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }
  throw lastError;
}

async function readProjects() {
  const files = (await readdir(projectsDir)).filter(file => file.endsWith(".json"));
  const projects = [];
  for (const file of files) {
    const fullPath = path.join(projectsDir, file);
    projects.push({
      file,
      fullPath,
      data: JSON.parse(await readFile(fullPath, "utf8")),
    });
  }
  return projects
    .sort((a, b) => {
      const rec = (b.data.analysis?.recommendation ?? 0) - (a.data.analysis?.recommendation ?? 0);
      return rec || (b.data.stars ?? 0) - (a.data.stars ?? 0);
    })
    .slice(0, maxProjects);
}

async function downloadArchive(project, archivePath) {
  const url = `https://api.github.com/repos/${project.owner}/${project.repo}/zipball`;
  const response = await fetch(url, {
    headers: githubHeaders,
    redirect: "follow",
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  const partialPath = `${archivePath}.partial`;
  await rm(partialPath, { force: true });
  await pipeline(response.body, createWriteStream(partialPath));
  await rename(partialPath, archivePath);
}

async function findExistingArchive(projectFolder, slug) {
  try {
    const files = await readdir(projectFolder);
    const archives = files
      .filter(file => file.startsWith(`${slug}-`) && file.endsWith(".zip"))
      .sort()
      .reverse();
    return archives[0] ?? null;
  } catch {
    return null;
  }
}

async function syncProject(projectEntry) {
  const project = projectEntry.data;
  const projectFolder = path.join(nasDir, project.slug);
  const archiveName = `${project.slug}-${archiveDate}.zip`;
  const archivePath = path.join(projectFolder, archiveName);
  const localArchivePath = path.join(cacheDir, archiveName);

  await withRetry(`mkdir ${project.slug}`, () => mkdir(projectFolder, { recursive: true }));

  let finalArchiveName = await findExistingArchive(projectFolder, project.slug);
  let finalArchivePath = finalArchiveName ? path.join(projectFolder, finalArchiveName) : archivePath;

  if (!finalArchiveName) {
    await mkdir(cacheDir, { recursive: true });
    if (!(await pathExists(localArchivePath))) {
      await withRetry(`download ${project.fullName}`, () => downloadArchive(project, localArchivePath), 3);
    }
    await withRetry(`copy ${project.slug} to NAS`, () => copyFile(localArchivePath, archivePath), 3);
    finalArchiveName = archiveName;
    finalArchivePath = archivePath;
  }

  const archiveStat = await stat(finalArchivePath);
  const nasUrl = joinUrl(publicBaseUrl, project.slug, finalArchiveName);
  const updated = {
    ...project,
    nasUrl,
    nasSyncedAt: new Date().toISOString(),
    nasArchiveSize: archiveStat.size,
  };

  await writeFile(projectEntry.fullPath, `${JSON.stringify(updated, null, 2)}\n`);
  return { slug: project.slug, nasUrl, size: archiveStat.size };
}

async function cleanupOldArchives() {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  let projectFolders = [];
  try {
    projectFolders = await readdir(nasDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const folder of projectFolders.filter(item => item.isDirectory())) {
    const folderPath = path.join(nasDir, folder.name);
    const files = await readdir(folderPath, { withFileTypes: true });
    for (const file of files.filter(item => item.isFile() && item.name.endsWith(".zip"))) {
      const filePath = path.join(folderPath, file.name);
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < cutoff) {
        await rm(filePath);
        removed.push(filePath);
      }
    }
  }
  return removed;
}

async function main() {
  requiredEnv("TREND_NAS_DIR", nasDir);
  requiredEnv("TREND_NAS_PUBLIC_BASE_URL", publicBaseUrl);

  await mkdir(nasDir, { recursive: true });
  const projects = await readProjects();
  const synced = [];

  for (const project of projects) {
    try {
      synced.push(await syncProject(project));
    } catch (error) {
      console.warn(`sync failed for ${project.data.fullName}: ${error.message}`);
    }
  }

  const removed = await cleanupOldArchives();
  console.log(`NAS synced: ${synced.length}`);
  console.log(`NAS cleanup removed: ${removed.length}`);
  for (const item of synced) {
    console.log(`${item.slug}: ${item.nasUrl}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
