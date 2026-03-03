# 通用 Windows 远程自动运行（Mac 触发）

目标：在 Mac 任意项目目录执行一条命令，自动让 Windows 对应项目完成 `git pull`、安装依赖、运行命令，并把日志拉回本地。

## 1. 路径映射规则（默认）

- Mac 根目录：`/Users/tison`
- Windows 根目录：`C:\`

自动映射示例：
- `/Users/tison/wxdaochu` -> `C:\wxdaochu`
- `/Users/tison/arkme/jotmo-data` -> `C:\arkme\jotmo-data`

可用环境变量覆盖：
- `WIN_REPO_DIR`：直接指定 Windows 项目路径（最高优先级）
- `WIN_PROJECT_REL`：手动指定相对路径（次优先级）

## 2. Windows 一次性准备

1. 启用 OpenSSH Server（安装并启动 `OpenSSH SSH Server` 服务）。
2. 确保 Windows 能执行 `git`、`node`、`npm`（在 `PATH`）。
3. 确保目标项目在 Windows 存在且路径与映射一致（或你设置了 `WIN_REPO_DIR`）。
4. Mac 到 Windows 配置 SSH 免密登录（推荐）。

## 3. Mac 端执行

在任意项目根目录运行：

```bash
WIN_HOST=192.168.1.23 WIN_USER=your-user /Users/tison/wxdaochu/scripts/remote-win/run-remote-win.sh
```

在当前项目执行自定义命令：

```bash
WIN_HOST=192.168.1.23 WIN_USER=your-user /Users/tison/wxdaochu/scripts/remote-win/run-remote-win.sh "npm run electron:dev"
```

或在本仓库内：

```bash
WIN_HOST=192.168.1.23 WIN_USER=your-user npm run win:remote
```

## 4. 分支策略

- 默认行为：自动读取 Mac 当前项目的当前分支，并让 Windows 切到同名分支执行。
- 如需覆盖：设置 `WIN_BRANCH=xxx`。
- 如需跳过 git 同步：设置 `WIN_SKIP_GIT=1`。

## 5. 日志位置

- Windows：`C:\codex-logs\codex-remote\<timestamp>\`
- Mac：`<当前项目>/logs/remote-win/<timestamp>/`

关键文件：
- `run.log`：整体流程日志
- `command.log`：目标命令输出
- `summary.json`：状态摘要

## 6. 常用参数

- `WIN_HOST`：Windows IP 或域名（必填）
- `WIN_USER`：Windows 用户名（必填）
- `WIN_PORT`：SSH 端口（默认 `22`）
- `MAC_ROOT`：Mac 映射根目录（默认 `/Users/tison`）
- `WIN_ROOT`：Windows 映射根目录（默认 `C:\`）
- `WIN_REPO_DIR`：Windows 项目绝对路径
- `WIN_PROJECT_REL`：相对根路径，如 `arkme/jotmo-data`
- `WIN_COMMAND`：执行命令（默认 `npm run build`）
- `WIN_BRANCH`：指定分支（默认自动检测本地当前分支）
- `WIN_SKIP_GIT=1`：跳过 `git fetch/switch/pull`
- `WIN_SKIP_INSTALL=1`：跳过 `npm ci`
- `WIN_LOG_ROOT`：Windows 日志根（默认 `C:\codex-logs\codex-remote`）
- `LOCAL_LOG_ROOT`：Mac 日志根（默认 `<当前项目>/logs/remote-win`）
