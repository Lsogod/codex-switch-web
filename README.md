# Codex Switch Web

本地运行的 Codex 账号切换控制台。

它管理当前机器上的 `~/.codex` 和 `~/.codex-profiles`，提供账号切换、额度查看、优先级排序，以及额度用尽后的自动切号。

## 功能

- 查看当前激活的 profile、当前账号、登录状态和受管目录
- 列出本地已保存的 profiles，并显示安全元信息
- 读取每个账号的剩余额度、重置时间和 credit 状态
- 按优先级排序账号
  - 先看是否仍有额度
  - 有额度的账号里先按重置时间更早排序
  - 重置时间接近时再按剩余额度更少排序
- 手动切换到任意账号
- 删除非当前激活的账号 profile
- 启动 `codex login` 和设备码登录
- 执行 `codex logout`
- 自动把当前登录账号注册成 profile，优先使用邮箱命名
- 切换前合并 session/history 到共享目录，避免切号后历史会话“消失”
- 可选开启自动切号
  - 服务端持续检测当前激活账号的额度
  - 额度用尽或被限流时，自动切换到下一个可用账号
  - 自动切换后会重新打开 Codex

## 工作方式

这个项目不是云服务，也不是代理层。

- 它只在本机运行
- 它不会上传你的 `auth.json`、token 或本地会话数据
- 页面只展示可安全读取的元信息
- 额度数据来自产品内部接口，接口路径和字段未来可能变化

会话保留机制：

- 各 profile 继续保留自己的账号配置，例如 `auth.json`、`config.toml`
- thread/session 历史在切换前会合并到 `~/.codex-profiles/.shared-sessions`
- 各 profile 的相关历史文件会链接到共享目录
- 桌面端的 `/.codex-global-state.json` 也会合并成共享状态，尽量保留 workspace 列表和侧边栏视图
- 因此切换账号后不会因为 `~/.codex` 指向变化而丢失旧会话

## 环境要求

- macOS
- 已安装并可运行 `codex`
- 已安装 `codex-switch`
- 已安装 Node.js 18+
- 建议安装并可使用这些系统命令：
  - `sqlite3`
  - `rsync`
  - `lsof`
  - `pkill`
  - `osascript`

## 安装与启动

克隆仓库后：

```bash
npm install
npm start
```

默认监听：

```text
http://127.0.0.1:4312
```

这个项目没有前端构建步骤，直接由 `server.js` 提供静态页面和 API。

## 使用说明

### 1. 登录第一个账号

打开页面后，点击：

- `CLI 登录`
或
- `设备码登录`

页面会打开终端，让你完成 `codex login`。

登录成功后，服务会尝试把当前账号自动保存为一个 profile，优先使用邮箱命名。

### 2. 登录多个账号

重复执行以下流程：

1. 在网页中切换到你想操作的 profile
2. 让页面自动关闭当前 Codex 相关进程
3. 完成目标账号登录
4. 等待服务自动把账号保存到 `~/.codex-profiles`

### 3. 手动切换账号

在账号列表中点击 `切换到此账号`。

切换时服务会：

1. 先合并并链接共享 session/history
2. 必要时关闭正在占用 `~/.codex` 的 Codex 相关进程
3. 执行 `codex-switch use`
4. 切换成功后重新打开 Codex

### 4. 查看额度和优先级

页面会显示：

- 当前账号额度
- 每个账号的额度进度
- 建议优先级

优先级规则：

1. 没额度的账号排最后
2. 有额度的账号先比较重置时间
3. 更早重置的账号优先
4. 如果重置时间接近，再优先使用剩余额度更少的账号

### 5. 开启自动切号

在“常用操作”区域打开 `自动切号`。

开启后：

- 服务每 15 秒检测一次当前激活账号的额度
- 如果当前账号额度用尽或被限流，会自动选择下一个可用账号
- 切换后会自动重新打开 Codex

说明：

- 自动切号是在服务端运行的，不依赖浏览器页面一直开着
- 只要本服务还在运行，自动切号就会继续工作

## 常见操作

### 停止和重启服务

前台启动时，直接结束 `npm start` 即可。

如果你用的是 `launchd`，常见命令如下。把示例路径替换成你自己的实际位置：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.codex-switch-web.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.codex-switch-web.plist
launchctl kickstart -k gui/$(id -u)/com.example.codex-switch-web
launchctl print gui/$(id -u)/com.example.codex-switch-web
```

### 查看日志

如果你通过 `launchd` 常驻运行，日志文件位置由你的 plist 决定。

如果你使用的是前台启动，日志直接看当前终端输出即可。

## API 概览

主要 API：

- `GET /api/state`
- `POST /api/profile/use`
- `POST /api/profile/delete`
- `POST /api/login/start`
- `POST /api/login/start-device-auth`
- `POST /api/login/logout`
- `GET /api/auto-switch`
- `POST /api/auto-switch`

服务本身还保留了一些内部/扩展接口，例如 profile 保存、重命名和 session repair，但当前界面不一定全部暴露为按钮。

## 安全与脱敏

公开仓库时应注意：

- 不要提交 `~/.codex`、`~/.codex-profiles` 或任何 profile 数据
- 不要提交日志文件
- 不要提交个人 `LaunchAgent` plist，除非已经去掉本地用户名、绝对路径和私有目录信息
- 不要在 README 中保留真实用户名、家目录路径、邮箱或本地日志路径

本仓库当前只包含应用代码与文档，不包含账号数据。

## 已知限制

- 额度读取依赖产品内部接口，不是公开稳定 API
- 如果 OpenAI 修改了接口路径或返回字段，需要同步调整代码
- 自动切号会主动关闭占用 `~/.codex` 的 Codex 相关进程，以确保切换真正生效

## License

如果你要公开发布，建议在仓库里补一个明确的 LICENSE 文件。
