# X 热门帖模块

报告页支持在 GitHub 周榜/月榜下方展示第二大模块：`X 热门帖雷达`。

## 数据逻辑

1. 按地区获取 X Trends。
2. 对每个趋势话题搜索近期热门帖。
3. 按互动热度排序，保留前 30 条。
4. 页面按区域切换展示，每个区域两列，每列 15 条。

## 环境变量

```bash
export X_BEARER_TOKEN="你的 X API Bearer Token"
export X_TREND_MAX_POSTS="30"
```

可选自定义地区：

```bash
export X_TREND_REGIONS="global:全球:1,us:美国:23424977,japan:日本:23424856,singapore:新加坡:23424948,hongkong:中国香港:24865698"
```

格式：

```txt
区域ID:页面显示名:WOEID
```

## 运行

```bash
pnpm trends:x
pnpm build
```

生成文件：

```txt
src/data/trends/x/YYYY-MM-DD.json
```

没有生成数据时，页面会显示“等待接入 X API”，不会伪造热门帖。

## 每日自动化

`.github/workflows/trends.yml` 已接入 X 热门帖自动生成流程。

每天定时任务会执行：

```txt
pnpm trends:run
pnpm trends:x
pnpm build
提交 src/data/trends/**/*.json
```

需要在 GitHub 仓库配置：

### Secrets

```txt
X_BEARER_TOKEN
```

这是 X API Bearer Token。没有这个值时，GitHub Actions 会跳过 X 热门帖采集。

### Variables

```txt
X_TREND_MAX_POSTS = 30
X_TREND_REGIONS = global:全球:1,us:美国:23424977,japan:日本:23424856,singapore:新加坡:23424948,hongkong:中国香港:24865698
```

`X_TREND_REGIONS` 控制页面上可切换的区域。新增区域时，按这个格式追加：

```txt
区域ID:页面显示名:WOEID
```

例如：

```txt
uk:英国:23424975
india:印度:23424848
korea:韩国:23424868
```

## 注意

X 官方趋势和搜索能力依赖开发者权限、套餐和限流。生产环境应记录每次请求的状态码和限流头，并在 429 时自动退避。
