import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "src", "data", "trends");
const projectsDir = path.join(dataDir, "projects");
const reportsDir = path.join(dataDir, "reports");
const logsDir = path.join(dataDir, "logs");
const execFileAsync = promisify(execFile);

const limit = Number.parseInt(process.env.TREND_LIMIT ?? "10", 10);
const forceReanalyze = process.env.FORCE_REANALYZE === "1";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const githubHeaders = {
  "User-Agent": "open-qiyuebao-trend-reporter",
  Accept: "application/vnd.github+json",
};

if (process.env.GITHUB_TOKEN) {
  githubHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

async function ensureDirs() {
  await Promise.all([
    mkdir(projectsDir, { recursive: true }),
    mkdir(reportsDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
  ]);
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...githubHeaders, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...githubHeaders, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

function stripHtml(value = "") {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function projectSlug(owner, repo) {
  return `${owner}__${repo}`.toLowerCase();
}

function parseNumber(value = "") {
  const parsed = Number.parseInt(value.replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scoreProject(repo, readme) {
  let score = 2;
  const text = `${repo.description ?? ""}\n${readme ?? ""}`.toLowerCase();
  if (repo.stargazers_count >= 10000) score += 0.7;
  else if (repo.stargazers_count >= 3000) score += 0.45;
  else if (repo.stargazers_count >= 1000) score += 0.25;
  if (repo.pushed_at && Date.now() - new Date(repo.pushed_at).getTime() < 1000 * 60 * 60 * 24 * 30) score += 0.5;
  if (text.includes("docker") || text.includes("docker compose")) score += 0.45;
  if (text.includes("self-host") || text.includes("self host") || text.includes("private deployment")) score += 0.25;
  if (text.includes("api") || text.includes("workflow") || text.includes("automation")) score += 0.25;
  if (repo.archived) score -= 1.2;
  return Math.max(1, Math.min(5, Math.round(score * 10) / 10));
}

function detectTags(repo, readme) {
  const text = `${repo.name} ${repo.description ?? ""} ${readme ?? ""}`.toLowerCase();
  const tags = new Set();
  const rules = [
    ["AI", [" ai ", "llm", "agent", "rag", "model", "prompt"]],
    ["效率工具", ["productivity", "automation", "workflow", "cli"]],
    ["开发工具", ["developer", "devtool", "sdk", "framework", "debug"]],
    ["NAS", ["nas", "self-host", "self host", "docker compose"]],
    ["自部署", ["docker", "kubernetes", "self-host", "deploy"]],
    ["数据分析", ["analytics", "dashboard", "visualization", "database"]],
    ["企业工具", ["enterprise", "crm", "admin", "platform"]],
    ["自动化办公", ["office", "spreadsheet", "document", "email", "automation"]],
    ["安全隐私", ["security", "privacy", "auth", "encryption"]],
  ];
  for (const [tag, keywords] of rules) {
    if (keywords.some(keyword => text.includes(keyword))) tags.add(tag);
  }
  if (!tags.size) tags.add("值得跟踪");
  return [...tags];
}

function detectDocs(repo, readme) {
  const urls = [...readme.matchAll(/https?:\/\/[^\s)>"']+/g)].map(match => match[0]);
  const docUrl = urls.find(url => /doc|guide|quickstart|install/i.test(url));
  return repo.homepage || docUrl || "";
}

function detectInstall(readme) {
  const lower = readme.toLowerCase();
  const commands = [];
  for (const line of readme.split("\n")) {
    const trimmed = line.trim();
    if (/^(npm|pnpm|yarn|pip|uv|brew|go install|cargo install|docker|git clone)\b/.test(trimmed)) {
      commands.push(trimmed.replace(/^`+|`+$/g, ""));
    }
    if (commands.length >= 5) break;
  }
  if (commands.length) return commands.join("\n");
  if (lower.includes("docker compose")) return "README 中出现 Docker Compose，可优先查看官方部署段落。";
  if (lower.includes("docker")) return "README 中出现 Docker，可进一步核对镜像、端口和持久化目录。";
  return "README 未识别出明确安装命令，需要人工核对官方文档。";
}

function inferProjectProfile(project, readme) {
  const text = `${project.fullName} ${project.description ?? ""} ${readme ?? ""}`.toLowerCase();
  const base = {
    object: "一个值得跟踪的开源项目",
    primaryUse: "技术选型、原型验证和同类产品研究",
    problem: "降低技术团队发现、理解和验证新工具的成本",
    audience: "技术负责人、独立开发者、小团队和需要寻找可复用工具的业务人员",
    commercialAngle: "更适合作为选型池和原型组件，能否商业化取决于场景匹配、部署成本和维护连续性。",
    deploymentAngle: "需要先核对运行环境、第三方服务依赖、许可证和数据安全边界。",
    riskFocus: "主要风险在于 README 信息不足、依赖复杂度不明和生产环境验证不足。",
    scenarios: ["技术选型初筛", "内部工具原型验证", "同类产品和工程实践研究"],
  };

  const profiles = [
    {
      test: /openhuman|personal ai|private.*ai|super intelligence/,
      value: {
        object: "一个面向个人私有 AI 助手的开源项目",
        primaryUse: "把个人知识、工具调用和 AI 能力组织成可自主管理的工作入口",
        problem: "个人和小团队在使用 AI 时，往往面临数据分散、工具链割裂、隐私不可控和工作流难沉淀的问题",
        audience: "重视隐私的个人用户、AI 工具重度使用者、希望自建 AI 工作台的小团队",
        commercialAngle: "价值不在“又一个聊天界面”，而在能否把私有数据、任务流程和工具调用沉淀为稳定入口；若部署体验足够顺滑，可以包装成私有 AI 助手或企业内部效率工作台。",
        deploymentAngle: "应重点核对本地模型或外部模型依赖、数据存储位置、权限控制、插件/工具调用边界，以及是否支持 Docker 或服务器长期运行。",
        riskFocus: "风险集中在隐私承诺是否有工程实现支撑、AI 能力是否依赖海外服务、长期维护是否稳定，以及普通用户部署门槛是否过高。",
        scenarios: ["个人知识库与 AI 助手整合", "小团队内部 AI 工作台", "私有化 AI 工具原型验证", "面向 NAS 用户的自部署 AI 应用评估"],
      },
    },
    {
      test: /agentmemory|memory.*agent|agent.*memory/,
      value: {
        object: "一个面向 AI Agent 的记忆管理组件",
        primaryUse: "为智能体应用提供上下文记忆、长期状态和可复用会话能力",
        problem: "多数 Agent Demo 只能完成单轮任务，缺少可控、可追踪、可迁移的长期记忆层",
        audience: "AI 应用开发者、Agent 工作流团队、需要构建长期上下文能力的小型产品团队",
        commercialAngle: "如果接口清晰、存储可控，它可以成为 Agent 产品中的基础组件，而不是终端应用；商业复用重点在稳定性、可观测性和与现有数据系统的集成。",
        deploymentAngle: "需要核对数据库、向量存储、鉴权、清理策略和数据隔离能力，尤其要关注企业客户对隐私和审计的要求。",
        riskFocus: "风险在于记忆质量难评估、数据越权风险高、不同模型和工作流下效果波动较大。",
        scenarios: ["客服 Agent 长期上下文", "个人 AI 助手记忆层", "企业知识工作流状态管理", "Agent 框架二次开发"],
      },
    },
    {
      test: /cloakbrowser|stealth chromium|bot detection|playwright/,
      value: {
        object: "一个偏反检测场景的自动化浏览器项目",
        primaryUse: "提升自动化浏览器在测试、采集和复杂网页交互中的兼容性",
        problem: "常规 Playwright 或 Chromium 在部分站点容易被自动化检测拦截，影响测试和合规采集流程",
        audience: "自动化测试团队、数据采集团队、浏览器自动化开发者",
        commercialAngle: "可作为自动化链路的底层工具，但在商业化使用前必须明确合规边界，不能把反检测能力直接用于绕过平台规则。",
        deploymentAngle: "应重点核对浏览器补丁来源、运行镜像、系统依赖、并发稳定性和服务器资源消耗。",
        riskFocus: "合规风险和安全风险高于普通工具，必须避免用于违反目标网站条款的场景。",
        scenarios: ["复杂网页自动化测试", "内控允许范围内的数据采集", "Playwright 替代方案验证", "浏览器指纹研究"],
      },
    },
    {
      test: /claude\.md|claude code|coding pitfalls|karpathy|skills/,
      value: {
        object: "一个面向 AI 编程工作流的规则与提示词资产",
        primaryUse: "提升 Claude Code 或同类编码 Agent 的执行稳定性",
        problem: "AI 编程工具容易在上下文、测试、回滚和任务边界上犯重复错误，需要可复用的工程约束",
        audience: "使用 AI 编程的开发者、技术负责人、希望建立团队级 AI 编码规范的小团队",
        commercialAngle: "它更像知识资产而非软件系统，价值在于能否转化为团队开发规范、评审清单或定制化 Agent 工作流。",
        deploymentAngle: "无需复杂部署，但需要根据团队技术栈、代码规范和安全要求改写后才能稳定使用。",
        riskFocus: "风险在于规则泛化过度，直接复制可能不适合本地项目；需要结合真实仓库测试迭代。",
        scenarios: ["团队 AI 编码规范", "Codex/Claude Code 工作流优化", "代码评审清单", "开发者培训材料"],
      },
    },
    {
      test: /\bbun\b|javascript runtime|package manager|bundler/,
      value: {
        object: "一个 JavaScript 运行时和工具链项目",
        primaryUse: "提升前端和 Node.js 生态中的构建、运行和包管理效率",
        problem: "传统 JavaScript 工具链链路长、配置多、启动和构建成本高",
        audience: "前端工程团队、全栈开发者、追求构建速度的技术团队",
        commercialAngle: "商业价值主要来自工程效率提升和基础设施降本，但大规模迁移要考虑生态兼容、CI 稳定性和团队学习成本。",
        deploymentAngle: "重点核对现有框架、依赖包、CI/CD、容器镜像和生产运行环境的兼容性。",
        riskFocus: "风险在生态边界和迁移成本，不宜只因热度高就替换成熟工具链。",
        scenarios: ["前端构建提速", "Node.js 服务运行时评估", "CI 构建优化", "开发工具链现代化"],
      },
    },
    {
      test: /research|academic|paper|literature/,
      value: {
        object: "一个面向学术研究或资料整理的效率工具",
        primaryUse: "改善文献检索、阅读、整理和研究输出流程",
        problem: "研究工作中资料分散、阅读链路长、引用和笔记难以结构化沉淀",
        audience: "研究人员、学生、行业分析师、知识工作者",
        commercialAngle: "适合包装成研究工作流模板或内部知识生产工具，付费价值取决于是否真正减少资料整理和写作前处理时间。",
        deploymentAngle: "重点核对数据来源、文件格式、引用管理工具兼容性和本地化使用体验。",
        riskFocus: "风险在于不同研究场景差异较大，自动化效果需要真实任务验证。",
        scenarios: ["文献阅读工作流", "研究资料整理", "行业报告素材管理", "AI 辅助研究流程"],
      },
    },
    {
      test: /trading|financial|finance|market/,
      value: {
        object: "一个金融或交易分析相关开源项目",
        primaryUse: "辅助市场研究、交易策略模拟或金融数据分析",
        problem: "金融研究和交易分析需要把数据、模型、信号和回测流程组织起来",
        audience: "量化研究者、金融科技团队、投研人员、数据分析团队",
        commercialAngle: "可作为研究样本或内部工具组件，但不能直接等同于可交易策略；商业使用要先验证数据质量、回测偏差和合规边界。",
        deploymentAngle: "重点核对行情数据源、API 依赖、模型假设、回测框架和结果可复现性。",
        riskFocus: "风险在于过拟合、数据源不稳定、合规约束和收益宣传不可控。",
        scenarios: ["投研辅助分析", "量化策略学习", "金融数据处理", "交易 Agent 原型验证"],
      },
    },
    {
      test: /security|hacking|osint|privacy|maigret/,
      value: {
        object: "一个安全、隐私或 OSINT 方向工具",
        primaryUse: "支持安全研究、身份线索核查或风险排查",
        problem: "安全和风控场景需要更快汇集公开线索、识别异常暴露或验证攻击面",
        audience: "安全研究员、企业安全团队、风控人员、合规审查人员",
        commercialAngle: "适合做成内部安全排查工具或咨询交付组件，但使用边界必须清晰，避免越权查询和隐私侵害。",
        deploymentAngle: "重点核对数据源合法性、调用频率限制、日志留存和敏感信息处理方式。",
        riskFocus: "风险主要是合规、隐私和误报，需要配套人工复核机制。",
        scenarios: ["公开信息风险排查", "账号暴露核查", "安全培训演示", "企业攻击面初筛"],
      },
    },
    {
      test: /video|image|diffusion|pixel|model/,
      value: {
        object: "一个多媒体生成或模型能力相关项目",
        primaryUse: "验证图像、视频或模型生成能力在内容生产中的可用性",
        problem: "内容团队和 AI 应用团队需要低成本评估新模型能否进入真实生产流程",
        audience: "AI 应用开发者、内容团队、设计团队、独立开发者",
        commercialAngle: "商业价值取决于生成质量、推理成本、版权边界和工作流集成能力，适合先做小样本评测。",
        deploymentAngle: "重点核对显存要求、模型权重下载、推理速度、许可证和国内网络可访问性。",
        riskFocus: "风险在算力成本、版权合规、模型稳定性和部署复杂度。",
        scenarios: ["AI 内容生产评测", "视频生成工作流", "模型私有化部署验证", "创意工具原型"],
      },
    },
  ];

  const matched = profiles.find(profile => profile.test.test(text));
  return matched ? { ...base, ...matched.value } : base;
}

function fallbackAnalysis(project, readme) {
  const hasDocker = /docker/i.test(readme);
  const hasCompose = /docker compose/i.test(readme);
  const active = project.pushedAt
    ? Date.now() - new Date(project.pushedAt).getTime() < 1000 * 60 * 60 * 24 * 45
    : false;
  const profile = inferProjectProfile(project, readme);
  const displayName = project.name || project.repo;
  const languageText = project.language ? `以 ${project.language} 为主的技术栈` : "现有技术栈";
  const maintainText = project.language ? `是否能由团队基于 ${project.language} 技术栈持续维护` : "是否能被团队持续维护";
  const starText = project.stars ? `当前 Star 约 ${project.stars.toLocaleString()}，` : "";
  const commercialAngle = profile.commercialAngle.replace(/[。.]$/, "");
  const riskFocus = profile.riskFocus.replace(/[。.]$/, "");

  const detailParagraphs = [
    `${displayName} 更准确地说是${profile.object}，而不是一个只因为短期热度上榜的仓库。对国内用户来说，判断重点不应停留在 README 的自我描述，而要看它是否能解决一个真实、可复用、可持续维护的工作流问题：${profile.problem}。`,
    `如果把它放进实际使用场景，${displayName} 的价值主要来自${profile.primaryUse}。${starText}说明它已经具备一定社区关注度，但商业用户更需要继续验证三件事：是否能嵌入现有业务流程，${maintainText}，以及是否能形成稳定交付而不是一次性 Demo。`,
    `从商业化和私有化角度看，${commercialAngle}。${profile.deploymentAngle}当前最需要警惕的是：${riskFocus}。因此建议先用一个小范围真实任务做部署测试，再决定它适合作为内部工具、客户方案组件，还是仅作为趋势观察样本。`,
  ];

  return {
    oneLine: `${displayName} 是${profile.object}，适合用于${profile.primaryUse}。`,
    problem: profile.problem,
    audience: profile.audience,
    detailParagraphs,
    scenarios: profile.scenarios,
    interpretation: `${displayName} 的评估重点是产品形态、工程成熟度和场景适配，而不是 README 文案本身。对付费信息服务用户来说，它的价值在于帮助快速判断是否值得投入一次部署验证、是否有二次开发空间、是否能成为降本增效工具或商业服务组件。`,
    installRequirements: project.language
      ? `通常需要 ${project.language} 相关运行环境，具体版本以官方 README 为准。`
      : "需要根据 README 和官方文档核对运行环境。",
    installGuide: detectInstall(readme),
    deployment: hasCompose
      ? "具备 Docker Compose 线索，适合进一步评估 NAS 或服务器私有化部署。"
      : hasDocker
        ? "具备 Docker 线索，可能适合容器化部署，但仍需核对镜像、数据目录和配置项。"
        : `${profile.deploymentAngle}暂未识别出明确 Docker Compose 部署路径，私有化部署成本需要进一步评估。`,
    commercialValue: project.stars >= 3000
      ? `${commercialAngle}；由于关注度较高，适合作为竞品研究、工具选型或方案组件候选。`
      : `${commercialAngle}；当前更适合作为早期趋势观察对象，商业复用前要确认真实需求和维护质量。`,
    efficiencyValue: `如果项目与现有工作流匹配，效率价值主要体现在${profile.primaryUse}，并减少从零选型和重复开发的时间。`,
    learningValue: `适合学习${languageText}下同类项目的产品组织、工程结构、README 表达和社区反馈。`,
    reuseValue: "具备二次开发可能，但需要结合许可证、代码结构、依赖复杂度、接口稳定性和维护节奏判断。",
    chinaNotes: "国内使用时要重点检查 GitHub、镜像源、模型服务、第三方 API 和 Docker 镜像访问稳定性。",
    risk: active ? profile.riskFocus : `近期活跃度可能不足；此外，${profile.riskFocus}`,
    recommendation: project.recommendation,
    tags: project.tags,
    source: "rule-based-readme-analysis",
  };
}

function buildProjectFromTrendingItem(item, windows) {
  const project = {
    slug: item.slug,
    owner: item.owner,
    repo: item.repo,
    name: item.repo,
    fullName: item.fullName,
    description: item.trendingDescription || "GitHub Trending 上榜项目，详细能力需要进一步核对 README 和官方文档。",
    language: item.trendingLanguage || "",
    githubUrl: `https://github.com/${item.fullName}`,
    docsUrl: "",
    stars: item.stars ?? 0,
    forks: item.forks ?? 0,
    openIssues: 0,
    license: "",
    pushedAt: "",
    updatedAt: "",
    createdAt: "",
    archived: false,
    trendWindows: windows,
    tags: [],
    recommendation: 0,
    readmeExcerpt: "",
    generatedAt: new Date().toISOString(),
  };

  project.tags = detectTags(project, "");
  project.recommendation =
    Math.round(Math.max(1, Math.min(5, 2 + Math.min(project.stars / 50000, 1.5))) * 10) / 10;
  return ensureAnalysisShape({
    ...project,
    analysis: fallbackAnalysis(project, ""),
  });
}

function ensureAnalysisShape(project) {
  const fallback = fallbackAnalysis(project, project.readmeExcerpt ?? "");
  const analysisSource = project.analysis?.source;
  const keepGenerated = analysisSource === "model" || analysisSource === "codex-cli";
  const analysis = forceReanalyze && !keepGenerated ? fallback : { ...fallback, ...(project.analysis ?? {}) };
  if (!Array.isArray(analysis.scenarios) || !analysis.scenarios.length) {
    analysis.scenarios = fallback.scenarios;
  }
  if (!Array.isArray(analysis.tags) || !analysis.tags.length) {
    analysis.tags = project.tags?.length ? project.tags : fallback.tags;
  }
  if (!Array.isArray(analysis.detailParagraphs) || analysis.detailParagraphs.length < 3) {
    analysis.detailParagraphs = fallback.detailParagraphs;
  }
  return {
    ...project,
    analysis,
  };
}

function parseJsonFromModel(content) {
  const trimmed = content.trim().replace(/^```json\s*|\s*```$/g, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model output did not contain a JSON object");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function buildAnalysisPrompt(project, readme) {
  return `你是一个面向国内商业用户的开源项目战略分析师，读者包括企业数字化负责人、技术团队负责人、独立开发者、NAS/私有化部署用户和小团队创业者。

请基于 GitHub 仓库信息和 README，输出严格合法 JSON，不要 Markdown，不要代码块。

输出字段必须包含：
oneLine: 一句话中文介绍，40 字以内。
problem: 项目解决的问题，避免照抄 README。
audience: 适合哪些用户，必须具体。
detailParagraphs: 数组，必须至少 3 段，每段 120-220 个中文字符。三段分别回答：
  1. 项目是什么，以及为什么值得国内用户关注；
  2. 它可能进入哪些真实业务、工作流或个人效率场景；
  3. 商业化复用、私有化部署或二次开发时应如何评估。
scenarios: 数组，3-5 个典型使用场景。
interpretation: 中文深度解读，强调产品形态、技术路线和业务含义。
installRequirements: 安装要求，明确运行环境、依赖和前置条件；不确定时说明需要核对。
installGuide: 安装方式，优先提取 README 中的真实命令；没有命令时给出核查路径。
deployment: Docker / NAS / 私有化部署可行性判断。
commercialValue: 商业价值判断，说明能否降本增效、形成服务、作为组件复用或只适合观察。
efficiencyValue: 效率提升价值。
learningValue: 学习价值。
reuseValue: 二次开发价值。
chinaNotes: 国内使用注意事项，重点检查网络、镜像、模型/API、合规和数据安全。
risk: 风险提示，包括成熟度、维护频率、安全风险、依赖复杂度和部署不确定性。
recommendation: 1-5 数字，可带一位小数。
tags: 数组，从 AI、效率工具、开发工具、NAS、自部署、数据分析、企业工具、自动化办公、安全隐私、值得跟踪中选择，可补充少量新标签。

判断要求：
- 不要只翻译 README。
- 不要夸大项目能力。
- 站在付费信息服务用户视角，输出可用于项目详情页的中文内容。
- 如果 README 信息不足，要明确写出“不确定，需要人工核查”的边界。

项目：${project.fullName}
语言：${project.language ?? ""}
描述：${project.description ?? ""}
Star：${project.stars}
Fork：${project.forks}
README 摘要：
${readme.slice(0, 12000)}`;
}

async function analyzeWithCodexCli(project, readme) {
  if (process.env.CODEX_CLI_ANALYSIS !== "1") return null;
  const outputFile = path.join(logsDir, `codex-analysis-${project.slug}.json`);
  const prompt = `${buildAnalysisPrompt(project, readme)}

只输出 JSON 对象本身。`;
  await execFileAsync(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--output-last-message",
      outputFile,
      "-C",
      rootDir,
      prompt,
    ],
    { timeout: 180000, maxBuffer: 1024 * 1024 * 4 }
  );
  const content = await readFile(outputFile, "utf8");
  return { ...parseJsonFromModel(content), source: "codex-cli" };
}

async function analyzeWithModel(project, readme) {
  if (!process.env.OPENAI_API_KEY) return null;
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const prompt = buildAnalysisPrompt(project, readme);

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "只输出合法 JSON。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.25,
    }),
  });

  if (!response.ok) {
    throw new Error(`model ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  return { ...parseJsonFromModel(content), source: "model" };
}

async function fetchTrending(since) {
  const html = await fetchText(`https://github.com/trending?since=${since}`);
  return html
    .split('<article class="Box-row"')
    .slice(1)
    .map(block => {
      const headingMatch = block.match(/<h2[\s\S]*?<\/h2>/);
      const repoMatch = (headingMatch?.[0] ?? block).match(/href="\/([^/\s"]+)\/([^/\s"]+)"/);
      if (!repoMatch) return null;
      const [, owner, repo] = repoMatch;
      if (["login", "sponsors", "trending", "features", "topics"].includes(owner)) return null;
      const descriptionMatch = block.match(/<p class="col-9 color-fg-muted my-1 pr-4">([\s\S]*?)<\/p>/);
      const languageMatch = block.match(/itemprop="programmingLanguage">([\s\S]*?)<\/span>/);
      const plainText = stripHtml(block);
      const starsMatch = plainText.match(/([0-9,]+)\s+stars/i);
      const forksMatch = plainText.match(/([0-9,]+)\s+forks/i);
      const gainedMatch = stripHtml(block).match(/([0-9,]+)\s+stars?\s+(today|this week|this month)/i);
      return {
        owner,
        repo,
        slug: projectSlug(owner, repo),
        fullName: `${owner}/${repo}`,
        trendingDescription: descriptionMatch ? stripHtml(descriptionMatch[1]) : "",
        trendingLanguage: languageMatch ? stripHtml(languageMatch[1]) : "",
        stars: starsMatch ? parseNumber(starsMatch[1]) : 0,
        forks: forksMatch ? parseNumber(forksMatch[1]) : 0,
        gainedStars: gainedMatch ? parseNumber(gainedMatch[1]) : null,
        trendingWindow: since,
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

async function enrichProject(item, windows) {
  const repo = await fetchJson(`https://api.github.com/repos/${item.owner}/${item.repo}`);
  let readme = "";
  try {
    readme = await fetchText(`https://api.github.com/repos/${item.owner}/${item.repo}/readme`, {
      headers: { Accept: "application/vnd.github.raw" },
    });
  } catch (error) {
    readme = "";
  }

  const baseProject = {
    slug: item.slug,
    owner: item.owner,
    repo: item.repo,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || item.trendingDescription,
    language: repo.language || item.trendingLanguage,
    githubUrl: repo.html_url,
    docsUrl: detectDocs(repo, readme),
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    license: repo.license?.spdx_id ?? "",
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    createdAt: repo.created_at,
    archived: repo.archived,
    trendWindows: windows,
    tags: [],
    recommendation: 0,
    readmeExcerpt: readme.slice(0, 3000),
    generatedAt: new Date().toISOString(),
  };

  baseProject.tags = detectTags(baseProject, readme);
  baseProject.recommendation = scoreProject(baseProject, readme);

  let analysis = null;
  try {
    analysis = await analyzeWithCodexCli(baseProject, readme);
    analysis ??= await analyzeWithModel(baseProject, readme);
  } catch (error) {
    analysis = null;
    await appendLog("generation_logs", {
      level: "warn",
      message: `model analysis failed for ${baseProject.fullName}: ${error.message}`,
    });
  }

  const finalAnalysis = analysis ?? fallbackAnalysis(baseProject, readme);
  if (!Array.isArray(finalAnalysis.detailParagraphs) || finalAnalysis.detailParagraphs.length < 3) {
    finalAnalysis.detailParagraphs = fallbackAnalysis(baseProject, readme).detailParagraphs;
  }

  return {
    ...baseProject,
    analysis: finalAnalysis,
  };
}

async function appendLog(name, entry) {
  await mkdir(logsDir, { recursive: true });
  const file = path.join(logsDir, `${name}.jsonl`);
  await writeFile(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, {
    flag: "a",
  });
}

async function readExistingProjects() {
  const projects = new Map();
  try {
    const files = await readdir(projectsDir);
    for (const file of files.filter(file => file.endsWith(".json"))) {
      const data = JSON.parse(await readFile(path.join(projectsDir, file), "utf8"));
      projects.set(data.slug, data);
    }
  } catch {
    return projects;
  }
  return projects;
}

function buildReport(projects) {
  const weekly = projects.filter(project => project.trendWindows.includes("weekly"));
  const monthly = projects.filter(project => project.trendWindows.includes("monthly"));
  const recommended = [...projects]
    .sort((a, b) => b.analysis.recommendation - a.analysis.recommendation || b.stars - a.stars)
    .slice(0, 3);
  const commercial = projects
    .filter(project => /商业|复用|企业|效率/.test(project.analysis.commercialValue + project.analysis.reuseValue + project.tags.join(",")))
    .slice(0, 6);
  const deployable = projects
    .filter(project => /Docker|NAS|私有化|容器/.test(project.analysis.deployment + project.tags.join(",")))
    .slice(0, 6);
  const risky = projects
    .filter(project => /风险|不足|谨慎|复杂/.test(project.analysis.risk))
    .slice(0, 6);

  return {
    slug: today,
    date: today,
    title: `${today.replaceAll("-", "年").replace(/年(\d{2})年/, "年$1月")}日 GitHub 趋势项目报告`,
    description: `汇总 GitHub 周榜和月榜项目，面向国内用户提供中文解读、部署判断和商业价值筛选。`,
    generatedAt: new Date().toISOString(),
    stats: {
      totalProjects: projects.length,
      weeklyProjects: weekly.length,
      monthlyProjects: monthly.length,
      averageRecommendation:
        Math.round((projects.reduce((sum, project) => sum + project.analysis.recommendation, 0) / Math.max(projects.length, 1)) * 10) / 10,
    },
    sections: {
      recommended: recommended.map(project => project.slug),
      weekly: weekly.map(project => project.slug),
      monthly: monthly.map(project => project.slug),
      commercial: commercial.map(project => project.slug),
      deployable: deployable.map(project => project.slug),
      risky: risky.map(project => project.slug),
    },
    summary: {
      overview: `本期共纳入 ${projects.length} 个项目，其中周趋势 ${weekly.length} 个、月趋势 ${monthly.length} 个。筛选重点不是热度本身，而是项目是否具备明确场景、可部署性、商业复用价值和持续跟踪意义。`,
      conclusion: "建议先把高推荐项目作为选型观察池，再对部署成本、许可协议、数据安全和国内网络依赖进行人工复核。对商业用户而言，真正有价值的是把热门项目转化为可验证的内部效率工具、客户解决方案或学习样本。",
    },
    projectSlugs: projects.map(project => project.slug),
  };
}

async function main() {
  await ensureDirs();
  await appendLog("fetch_logs", { level: "info", message: `trend run started, limit=${limit}` });

  const [weeklyItems, monthlyItems] = await Promise.all([
    fetchTrending("weekly"),
    fetchTrending("monthly"),
  ]);

  const merged = new Map();
  for (const item of [...weeklyItems, ...monthlyItems]) {
    const existing = merged.get(item.slug);
    merged.set(item.slug, {
      ...item,
      windows: [...new Set([...(existing?.windows ?? []), item.trendingWindow])],
    });
  }

  const existingProjects = await readExistingProjects();
  const projects = [];
  for (const item of merged.values()) {
    try {
      const project = await enrichProject(item, item.windows);
      const previous = existingProjects.get(project.slug);
      const mergedProject = {
        ...previous,
        ...project,
        firstSeenAt: previous?.firstSeenAt ?? new Date().toISOString(),
      };
      const normalizedProject = ensureAnalysisShape(mergedProject);
      await writeFile(path.join(projectsDir, `${project.slug}.json`), `${JSON.stringify(normalizedProject, null, 2)}\n`);
      projects.push(normalizedProject);
      await appendLog("fetch_logs", { level: "info", message: `processed ${project.fullName}` });
    } catch (error) {
      const previous = existingProjects.get(item.slug);
      if (previous) {
        const reusedProject = ensureAnalysisShape({
          ...previous,
          trendWindows: item.windows,
          generatedAt: new Date().toISOString(),
        });
        await writeFile(path.join(projectsDir, `${item.slug}.json`), `${JSON.stringify(reusedProject, null, 2)}\n`);
        projects.push(reusedProject);
        await appendLog("fetch_logs", { level: "warn", message: `reused cached ${item.fullName}: ${error.message}` });
      } else {
        const fallbackProject = buildProjectFromTrendingItem(item, item.windows);
        await writeFile(path.join(projectsDir, `${item.slug}.json`), `${JSON.stringify(fallbackProject, null, 2)}\n`);
        projects.push(fallbackProject);
        await appendLog("fetch_logs", { level: "warn", message: `created fallback ${item.fullName}: ${error.message}` });
      }
    }
  }

  const report = buildReport(projects);
  await writeFile(path.join(reportsDir, `${report.slug}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await appendLog("generation_logs", { level: "info", message: `report generated ${report.slug}` });
  console.log(`Generated ${report.title}`);
  console.log(`Projects: ${projects.length}`);
}

main().catch(async error => {
  await appendLog("fetch_logs", { level: "fatal", message: error.message });
  console.error(error);
  process.exitCode = 1;
});
