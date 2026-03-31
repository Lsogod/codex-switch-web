# Codex Switch

仅适用于 macOS 的 Codex 多账号切换菜单栏 App。

它会常驻在状态栏，帮你管理本机的 Codex 账号、查看额度、切换账号，并可选显示悬浮额度球。

## 适用系统

这个项目当前只适用于 `macOS`。

- 不支持 Windows
- 不支持 Linux
- 当前发布包是 `macOS Apple Silicon (arm64)` 版本

## 下载

请直接从 GitHub Releases 下载最新安装包：

- [Releases](https://github.com/Lsogod/codex-switch-web/releases)
- [最新版本 v0.1.7](https://github.com/Lsogod/codex-switch-web/releases/tag/v0.1.7)
- [直接下载 DMG](https://github.com/Lsogod/codex-switch-web/releases/download/v0.1.7/Codex-Switch-0.1.7-arm64.dmg)
- [直接下载 ZIP](https://github.com/Lsogod/codex-switch-web/releases/download/v0.1.7/Codex-Switch-0.1.7-arm64.zip)

当前提供的文件通常有两个：

- `Codex-Switch-<version>-arm64.dmg`
- `Codex-Switch-<version>-arm64.zip`

推荐使用 `dmg`。

说明：

- 当前发布的是 `macOS Apple Silicon` 版本，也就是 `arm64`
- 适用于 M1、M2、M3、M4 等芯片的 Mac

## 安装

1. 下载最新的 `Codex-Switch-<version>-arm64.dmg`
2. 双击打开 `dmg`
3. 将 `Codex Switch.app` 拖到 `Applications`
4. 从“应用程序”中打开 `Codex Switch`

### 命令行安装

如果你更习惯用命令行，可以直接执行下面这组命令：

```bash
VERSION="0.1.7"
APP_NAME="Codex Switch"
DMG_NAME="Codex-Switch-${VERSION}-arm64.dmg"
DOWNLOAD_DIR="$HOME/Downloads/Codex-Switch"
DMG_PATH="$DOWNLOAD_DIR/$DMG_NAME"
VOLUME_PATH="/Volumes/${APP_NAME} ${VERSION}-arm64"

mkdir -p "$DOWNLOAD_DIR"

curl -L --fail -o "$DMG_PATH" \
  "https://github.com/Lsogod/codex-switch-web/releases/download/v${VERSION}/${DMG_NAME}"

hdiutil attach -nobrowse -readonly "$DMG_PATH"
rm -rf "/Applications/${APP_NAME}.app"
ditto "${VOLUME_PATH}/${APP_NAME}.app" "/Applications/${APP_NAME}.app"
hdiutil detach "$VOLUME_PATH"

open -na "/Applications/${APP_NAME}.app"
```

说明：

- 如果更新了版本，只需要把 `VERSION` 改成对应版本号
- 这组命令会用新版本覆盖 `/Applications/Codex Switch.app`

## 首次打开

这个 App 目前还没有 Apple Developer 签名和 notarization，所以第一次打开时，macOS 可能会拦截。

如果被系统拦住，按下面的方法打开：

1. 在“应用程序”里找到 `Codex Switch.app`
2. 右键应用，选择 `打开`
3. 在系统弹窗里再次选择 `打开`

如果还是被拦：

1. 打开 `系统设置 -> 隐私与安全性`
2. 在页面下方找到被拦截的 `Codex Switch`
3. 点击 `仍要打开`

## 使用前提

在使用这个 App 之前，请先确认你的 Mac 上已经有这些内容：

- 已安装 `Codex`
- 能正常登录和运行 Codex
- 机器可以访问 `chatgpt.com`

如果你的网络依赖代理，请先让系统代理或终端代理工作正常，否则额度读取可能失败。

### 什么是 codex-switch

`codex-switch` 是这个项目依赖的一个本地命令行工具。

它的作用很简单：

- 保存当前 `~/.codex` 的账号配置
- 在多个本地 Codex profile 之间切换
- 删除、重命名和查看 profile

这个菜单栏 App 自己不直接改写 `~/.codex`，而是调用 `codex-switch` 来完成底层 profile 切换。

对于通过 `DMG` 安装的版本：

- `codex-switch` 已经随 App 一起打包
- 不需要你再单独安装一次

### 安装 codex-switch

只有在下面这些场景里，你才需要手动安装 `codex-switch`：

- 你是从源码直接运行这个项目
- 你想在终端里单独使用 `codex-switch`

本仓库已经包含了 `codex-switch` 脚本，你可以直接安装到 `~/.local/bin`：

```bash
mkdir -p "$HOME/.local/bin"

curl -L --fail \
  -o "$HOME/.local/bin/codex-switch" \
  "https://raw.githubusercontent.com/Lsogod/codex-switch-web/main/bin/codex-switch"

chmod +x "$HOME/.local/bin/codex-switch"
```

如果你的 `PATH` 里还没有 `~/.local/bin`，请补上：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
export PATH="$HOME/.local/bin:$PATH"
```

安装完成后，可以用下面的命令检查：

```bash
codex-switch --help
```

## 如何使用

### 1. 启动 App

启动后，菜单栏会出现 `Codex`。

你可以通过状态栏菜单完成这些操作：

- `打开控制台`
- `启动 Codex`
- `账号列表`
- `显示悬浮额度`
- `开机自启`

### 2. 登录第一个账号

1. 点击状态栏里的 `Codex`
2. 选择 `打开控制台`
3. 在控制台里点击 `CLI 登录` 或 `设备码登录`
4. 按提示在 Terminal 中完成登录
5. 登录完成后，App 会把这个账号保存为一个本地 profile

### 3. 登录更多账号

重复上面的登录流程即可。

每次新登录一个账号，App 都会单独保存，不会覆盖之前的账号。

### 4. 切换账号

你可以通过两种方式切换：

- 在状态栏菜单的 `账号列表` 中直接点击目标账号
- 在控制台页面中点击对应账号的 `切换`

账号列表会按优先级排序显示：

- 先用更早重置的账号
- 重置时间接近时，优先使用剩余额度更少的账号
- 已经没有额度的账号排在最后

### 5. 启动 Codex

切换账号后，如果你想直接打开 Codex，可以：

- 在状态栏菜单点击 `启动 Codex`

### 6. 悬浮额度球

你可以在状态栏菜单里打开 `显示悬浮额度`。

开启后：

- 桌面上会显示一个悬浮额度球
- 中间显示当前账号的剩余额度
- 下方显示重置时间
- 右键悬浮球会弹出和状态栏相同的菜单
- 可以拖动位置

### 7. 开机自启

如果你希望它常驻使用，可以在状态栏菜单里打开 `开机自启`。

## 它会做什么

这个 App 只在你的本机运行。

它会管理本机的这些目录：

- `~/.codex`
- `~/.codex-profiles`

它会做这些事情：

- 保存多个 Codex 账号
- 在不同账号之间切换
- 读取每个账号的剩余额度和重置时间
- 尽量保留本地会话历史

它不会把你的本地账号数据上传到它自己的服务器，因为它本身没有云端服务。

## 常见问题

### 1. 为什么首次打开会被 macOS 提示风险

因为当前发布包还没有做 Apple 官方签名和 notarization。

这不影响它在本机运行，但第一次打开时需要你手动放行。

### 2. 为什么额度读取失败

常见原因是：

- 机器当前网络无法访问 `chatgpt.com`
- 代理配置没有生效
- 当前账号登录状态已经失效

### 3. 为什么登录或切换时系统弹出权限请求

这是正常的。

App 在登录和切换时，可能会调用：

- Terminal
- Codex

如果系统请求自动化权限，请允许，否则相关操作可能失败。

### 4. 为什么下载的是 arm64

因为当前发布的是 Apple Silicon 版本。

如果你使用的是 Intel Mac，需要单独构建对应版本。
