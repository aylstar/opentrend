# OpenTrend NAS 资源同步

项目详情页会在项目数据存在 `nasUrl` 时，自动显示“国内镜像 / NAS 下载”按钮。

## 环境变量

```bash
export TREND_NAS_DIR="/Volumes/your-nas/opentrend/projects"
export TREND_NAS_PUBLIC_BASE_URL="https://img.qiyuebao.xyz/opentrend/projects"
export TREND_NAS_RETENTION_DAYS="30"
export TREND_NAS_MAX_PROJECTS="20"
```

- `TREND_NAS_DIR`：NAS 在本机挂载后的目录，脚本会把 zip 包写入这里。
- `TREND_NAS_PUBLIC_BASE_URL`：外部用户访问该 NAS 目录的 URL 前缀。
- `TREND_NAS_RETENTION_DAYS`：旧 zip 包保留天数，默认 30 天。
- `TREND_NAS_MAX_PROJECTS`：每次同步的项目数量，默认按推荐指数和 Star 排序取前 20 个。

## 手动运行

```bash
pnpm trends:nas
pnpm build
```

运行后脚本会：

1. 读取 `src/data/trends/projects/*.json`。
2. 下载 GitHub 项目的 zipball 到 NAS。
3. 给项目 JSON 写入 `nasUrl`、`nasSyncedAt`、`nasArchiveSize`。
4. 清理超过保留天数的旧 zip 包。
5. 下一次构建时，项目详情页自动显示“国内镜像 / NAS 下载”。

## 建议自动化顺序

```bash
pnpm trends:run
pnpm trends:nas
pnpm build
pnpm dlx vercel --prod --yes
```

如果 NAS 只在你的 Mac 或本地网络里可访问，这个流程应放在本机 `cron`、`launchd` 或 NAS 计划任务中执行，不适合直接放到 Vercel Cron。
