# Codex Switch

本地运行的 Codex 多账号切换控制台，支持 Web 控制台和 Electron 菜单栏 App。

它管理当前机器上的 `~/.codex` 和 `~/.codex-profiles`，提供账号切换、额度查看、优先级排序，以及额度用尽后的自动切号。

## 功能

- 支持作为 Electron 菜单栏 App 运行，不再依赖手动打开浏览器
- 菜单栏 App 默认常驻顶部状态栏，可选显示悬浮额度球
- 需要完整界面时，可以从状态栏菜单手动打开完整控制台窗口
- 查看当前激活的 profile、当前账号、登录状态、当前额度和受管目录
- 列出本地已保存的 profiles，并显示安全元信息
- 账号列表使用紧凑条目卡展示，可展开查看详细信息
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
- 如果服务运行在 `launchd` 环境里缺少代理环境变量，会回退读取 macOS 系统代理配置来拉取额度接口

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
  - `curl`
  - `sqlite3`
  - `rsync`
  - `lsof`
  - `pkill`
  - `osascript`

## 快速开始

从克隆仓库到启动第一个界面，最短流程如下：

```bash
git clone git@github.com:Lsogod/codex-switch-web.git
cd codex-switch-web
npm install
```

启动 Web 版：

```bash
npm start
```

启动后打开：

```text
http://127.0.0.1:4312
```

或者直接启动菜单栏 App：

```bash
npm run app
```

然后在页面里：

1. 点击 `CLI 登录` 或 `设备码登录`
2. 按页面提示允许它关闭当前 Codex 相关进程
3. 在自动弹出的 Terminal 窗口里完成 `codex login`
4. 回到页面，等待它把当前账号自动保存成一个 profile
5. 之后继续重复同样流程登录第二个、第三个账号

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

### 菜单栏 App 运行

如果你不想通过浏览器使用，也可以直接运行：

```bash
npm run app
```

菜单栏 App 的行为：

- 优先复用已经在 `127.0.0.1:4312` 运行的本地服务
- 如果本地服务没启动，App 会自动拉起 `server.js`
- 默认不显示 Dock 主窗口，而是驻留在 macOS 菜单栏
- 左键或右键点击图标都会弹出菜单
- 状态栏菜单里可以直接启动 Codex、切换账号、打开控制台窗口、切换悬浮额度和开机自启
- 悬浮额度球默认只显示当前账号的剩余额度和重置时间，右键会弹出同一套菜单
- 更适合常驻使用，而不是长期占一个完整浏览器标签页

当前这套菜单栏 App 是 Electron 壳，核心逻辑仍然是本地 `server.js + public/`。

## GitHub 分发

如果你想把它放到 GitHub 让别人下载，目前项目已经提供了 macOS 构建链路：

```bash
npm run app:dmg
```

或一次生成 `dmg + zip`：

```bash
npm run app:dist
```

默认产物会输出到：

```text
dist/
```

仓库里还带了一个 GitHub Actions 工作流：

- [`.github/workflows/release-macos.yml`](./.github/workflows/release-macos.yml)

它支持两种方式：

- 手动触发 `workflow_dispatch`
- 推送 tag，例如 `v0.1.0`

工作流会在 `macos-14` 上构建 `dmg` 和 `zip`，并在 tag 触发时自动上传到 GitHub Releases。

非常重要的边界：

- 现在这套产物可以生成并上传 GitHub
- 但它还没有 `Developer ID` 签名，也没有 notarization
- 所以别人从 GitHub 下载后，macOS 很可能会提示来源不明或被 Gatekeeper 拦截

也就是说：

- 适合“技术用户自己下载后手动放行”
- 不适合当成完全无阻力的公开安装包

如果要做到真正的“下载后直接双击安装”，还需要继续接入：

- Apple Developer 证书签名
- Apple notarization
- 最好再补一个稳定的 Release 发布流程和签名密钥配置

## 权限与系统提示

这个项目要能正常工作，通常需要这些前提和权限：

- 可以访问本机目录 `~/.codex` 和 `~/.codex-profiles`
- 可以运行 `codex`、`codex-switch`、`curl`、`sqlite3` 等本地命令
- 可以通过 `osascript` 控制 Terminal 和 Codex.app
- 可以访问 `http://127.0.0.1:4312`
- 如果要读取额度，机器需要能访问 `https://chatgpt.com`

首次使用时，macOS 可能会弹出这些权限提示：

- `Terminal` 或当前运行服务的宿主进程请求控制 `Terminal`
- `Terminal` 或当前运行服务的宿主进程请求控制 `Codex`
- 浏览器访问本地地址 `127.0.0.1:4312`

如果你使用 `launchd` 常驻运行，这些自动化操作实际是由 `node` + `osascript` 完成的；如果你拒绝了相关权限，页面上的登录、切换、自动打开 Codex 可能会失败。

如果你的网络依赖代理：

- 前台运行时，服务会优先使用当前 shell 的代理环境变量
- `launchd` 运行时，如果环境变量缺失，服务会回退读取 macOS 系统代理配置
- 如果这两者都不可用，额度读取可能显示失败

## 使用说明

### 1. 登录第一个账号

打开页面后，点击：

- `CLI 登录`
或
- `设备码登录`

页面会打开终端，让你完成 `codex login`。

登录成功后，服务会尝试把当前账号自动保存为一个 profile，优先使用邮箱命名。

如果页面提示需要先关闭 Codex 相关进程，允许它执行即可；否则切换 `~/.codex` 时容易失败。

### 2. 登录多个账号

重复执行以下流程：

1. 点击 `CLI 登录` 或 `设备码登录`
2. 服务会先关闭相关 Codex 进程，并切到临时 `login-staging-*` profile
3. 在终端里完成目标账号登录
4. 登录成功后，服务会自动把当前账号注册成正式 profile，优先使用邮箱命名

你不需要先手动创建或切换到一个空 profile 再登录。

### 3. 手动切换账号

可以通过两种方式切换：

- Web 控制台里的 `切换`
- 状态栏菜单里的 `账号列表`

切换时服务会：

1. 先合并并链接共享 session/history
2. 必要时关闭正在占用 `~/.codex` 的 Codex 相关进程
3. 执行 `codex-switch use`
4. 切换成功后重新打开 Codex

### 4. 查看额度和优先级

页面会显示：

- 顶部当前账号额度概览
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

- `GET /api/health`
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
- Electron 菜单栏 App 当前是本地运行壳，还不是打包后的独立分发版

## License

如果你要公开发布，建议在仓库里补一个明确的 LICENSE 文件。
