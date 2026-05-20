# 开源项目趋势报告 MVP

## 产品定位

面向国内技术用户、独立开发者、小团队和企业数字化探索者，每天汇总 GitHub 周榜、月榜项目，输出中文解读、部署判断、商业价值和风险提示。

## 当前架构

```text
GitHub Trending / GitHub API
↓
scripts/trends/run.mjs
↓
src/data/trends/projects/*.json
src/data/trends/reports/*.json
src/data/trends/logs/*.jsonl
↓
Astro 静态页面
↓
Vercel 部署
```

MVP 阶段没有引入外部数据库，使用仓库内 JSON 文件作为轻量数据存储。优点是简单、可审计、能直接静态部署；后续可以迁移到 Supabase、PostgreSQL 或自建 CMS。

## 数据结构

当前用 JSON 文件模拟数据库表：

- `projects`：`src/data/trends/projects/*.json`
- `reports`：`src/data/trends/reports/*.json`
- `report_projects`：体现在报告 JSON 的 `sections` 和 `projectSlugs` 字段中
- `fetch_logs`：`src/data/trends/logs/fetch_logs.jsonl`
- `generation_logs`：`src/data/trends/logs/generation_logs.jsonl`

后续迁移数据库时，可拆成以下表：

```text
projects(id, slug, owner, repo, full_name, description, language, github_url, docs_url, stars, forks, license, pushed_at, created_at, archived)
project_analyses(id, project_id, one_line, problem, audience, install_guide, deployment, commercial_value, risk, recommendation, tags, generated_at)
reports(id, slug, date, title, description, overview, conclusion, generated_at)
report_projects(id, report_id, project_id, section, sort_order)
fetch_logs(id, level, message, created_at)
generation_logs(id, level, message, created_at)
```

## 页面结构

- `/trends/`：趋势报告列表
- `/trends/[date]/`：某日趋势报告详情
- `/projects/`：项目数据库，支持语言、标签、推荐指数筛选
- `/projects/[owner]__[repo]/`：项目详情页

项目库前台没有使用超宽表格，而是用紧凑卡片展示核心字段，详情页展示完整字段。

## 本地运行

```bash
pnpm install
pnpm trends:sample
pnpm dev --host 127.0.0.1
```

完整抓取：

```bash
pnpm trends:run
```

默认每个榜单抓取 10 个项目。如需调整：

```bash
TREND_LIMIT=20 pnpm trends:run
```

## 大模型生成

脚本支持可替换的大模型模块。未配置密钥时，会使用本地规则生成占位中文分析，保证流程可以跑通。

可选环境变量：

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
GITHUB_TOKEN=...
```

建议正式使用时配置 `GITHUB_TOKEN`，降低 GitHub API 限流风险。

## Vercel 部署

手动部署：

```bash
pnpm build
pnpm --config.proxy= --config.https-proxy= dlx vercel --prod --yes
```

如果用 GitHub Actions 定时生成报告，需要把仓库连接到 Vercel。Actions 每天提交新的 JSON 数据后，Vercel 会自动重新部署。

## 自动化路线

MVP：

- 每天抓 GitHub 周榜、月榜
- 自动生成中文解读
- 自动生成报告 JSON
- 网站静态展示

下一阶段：

- 接入会员登录和订阅权限
- 增加后台审核队列
- 增加 NAS / Docker 部署教程字段
- 增加 AI 工具、Hugging Face、Product Hunt、Papers with Code 数据源
- 增加项目评分模型和人工校准
- 增加邮件、企微、飞书或微信公众号推送
