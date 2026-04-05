const path = require("path");
const http = require("http");
const fsp = require("fs/promises");
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, screen, ipcMain } = require("electron");

const HOST = "127.0.0.1";
const PORT = app.isPackaged ? 4313 : Number.parseInt(process.env.PORT || "4312", 10);
const BASE_URL = `http://${HOST}:${PORT}`;
const STARTUP_ATTEMPTS = 40;
const STARTUP_DELAY_MS = 500;
const DASHBOARD_SIZE = { width: 1360, height: 920 };
const OVERLAY_COLLAPSED_SIZE = { width: 86, height: 96 };
const OVERLAY_COLLAPSED_NOTICE_SIZE = { width: 168, height: 128 };
const OVERLAY_EXPANDED_SIZE = { width: 278, height: 96 };
const OVERLAY_EXPANDED_NOTICE_SIZE = { width: 278, height: 128 };
const APP_VERSION_REFRESH_MS = 30 * 60 * 1000;

let tray = null;
let dashboardWindow = null;
let overlayWindow = null;
let quitting = false;
let overlayBoundsSaveTimer = null;
let overlayExpanded = false;
let menuProfilesSnapshot = [];
let menuProfilesError = null;
let menuProfilesRefreshTimer = null;
let menuProfilesRefreshInFlight = null;
let bundledServerModule = null;
let appVersionSnapshot = null;
let appVersionError = null;
let appVersionRefreshInFlight = null;
let appVersionRefreshTimer = null;
let overlayHasUpdateNotice = false;
let shellState = {
  overlay: {
    enabled: true,
    x: null,
    y: null
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBundledServerModule() {
  if (bundledServerModule) {
    return bundledServerModule;
  }

  const serverScriptPath = path.join(app.getAppPath(), "server.js");
  const previousPort = process.env.PORT;
  process.env.PORT = String(PORT);
  bundledServerModule = require(serverScriptPath);
  if (typeof previousPort === "string") {
    process.env.PORT = previousPort;
  } else {
    delete process.env.PORT;
  }

  return bundledServerModule;
}

function getHealthUrl() {
  return `${BASE_URL}/api/health`;
}

function getLoginItemOptions() {
  if (process.platform !== "darwin") {
    return {};
  }

  if (app.isPackaged) {
    return {};
  }

  return {
    path: process.execPath,
    args: [app.getAppPath()]
  };
}

function isLaunchAtLoginEnabled() {
  if (process.platform !== "darwin") {
    return false;
  }

  const settings = app.getLoginItemSettings(getLoginItemOptions());
  return Boolean(settings.openAtLogin);
}

function setLaunchAtLogin(enabled) {
  if (process.platform !== "darwin") {
    return;
  }

  app.setLoginItemSettings({
    ...getLoginItemOptions(),
    openAtLogin: Boolean(enabled),
    openAsHidden: true
  });
}

function getShellStatePath() {
  return path.join(app.getPath("userData"), "shell-state.json");
}

function isLocalAppUrl(url) {
  return typeof url === "string" && url.startsWith(BASE_URL);
}

function normalizeShellState(raw) {
  return {
    overlay: {
      enabled: raw?.overlay?.enabled !== false,
      x: Number.isFinite(raw?.overlay?.x) ? raw.overlay.x : null,
      y: Number.isFinite(raw?.overlay?.y) ? raw.overlay.y : null
    },
    autoUpdateChecks: {
      enabled: raw?.autoUpdateChecks?.enabled !== false
    }
  };
}

async function loadShellState() {
  try {
    const raw = JSON.parse(await fsp.readFile(getShellStatePath(), "utf8"));
    shellState = normalizeShellState(raw);
  } catch {
    shellState = normalizeShellState(null);
  }
}

async function saveShellState() {
  const filePath = getShellStatePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(shellState, null, 2)}\n`, "utf8");
  await fsp.rename(tmpPath, filePath);
}

function queueOverlayBoundsSave() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  clearTimeout(overlayBoundsSaveTimer);
  overlayBoundsSaveTimer = setTimeout(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    const bounds = overlayWindow.getBounds();
    shellState.overlay.x = bounds.x;
    shellState.overlay.y = bounds.y;
    saveShellState().catch(() => {});
  }, 180);
}

function clampWindowToWorkArea(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const { workArea } = display;

  return {
    x: Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - width - 8)),
    y: Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8))
  };
}

function createTrayIcon() {
  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2.5" width="14" height="13" rx="3.2" fill="black"/>
      <path d="M11.9 5.3H7.2c-1.6 0-2.9 1.3-2.9 2.9v1.6c0 1.6 1.3 2.9 2.9 2.9h4.7" fill="none" stroke="white" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9.8 9h3.3" fill="none" stroke="white" stroke-width="1.85" stroke-linecap="round"/>
    </svg>
  `.trim();

  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image.resize({ width: 18, height: 18 });
}

const PLUS_WEEKLY_ALERT_THRESHOLD = 10;

function clampMenuPercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getMenuUsageWindows(usageData) {
  return [usageData?.primary, usageData?.secondary].filter(
    (windowInfo) => windowInfo && windowInfo.remainingPercent != null
  );
}

function isWeeklyMenuWindow(windowInfo) {
  if (!windowInfo) {
    return false;
  }
  if (Number.isFinite(windowInfo.windowDurationMins) && windowInfo.windowDurationMins >= (6 * 24 * 60)) {
    return true;
  }
  return /week/i.test(String(windowInfo.label || ""));
}

function compareMenuWindows(a, b) {
  const remainingA = clampMenuPercent(a?.remainingPercent);
  const remainingB = clampMenuPercent(b?.remainingPercent);
  if (remainingA == null && remainingB == null) {
    return 0;
  }
  if (remainingA == null) {
    return 1;
  }
  if (remainingB == null) {
    return -1;
  }
  if (remainingA !== remainingB) {
    return remainingA - remainingB;
  }

  const resetA = a?.resetAt ? new Date(a.resetAt).getTime() : Number.POSITIVE_INFINITY;
  const resetB = b?.resetAt ? new Date(b.resetAt).getTime() : Number.POSITIVE_INFINITY;
  if (resetA !== resetB) {
    return resetA - resetB;
  }

  const durationA = Number.isFinite(a?.windowDurationMins) ? a.windowDurationMins : 0;
  const durationB = Number.isFinite(b?.windowDurationMins) ? b.windowDurationMins : 0;
  return durationB - durationA;
}

function getMenuWindowLabel(windowInfo) {
  if (!windowInfo) {
    return null;
  }
  if (isWeeklyMenuWindow(windowInfo)) {
    return "周额度";
  }

  const minutes = Number.isFinite(windowInfo.windowDurationMins) ? windowInfo.windowDurationMins : null;
  if (minutes != null && minutes >= 60) {
    return `${Math.round(minutes / 60)}小时`;
  }
  if (minutes != null && minutes > 0) {
    return `${minutes}分钟`;
  }
  return String(windowInfo.label || "").trim() || null;
}

function resolveMenuUsageState(profile, previousProfile) {
  const usageData = profile?.usage?.data || null;
  const windows = getMenuUsageWindows(usageData);
  const weeklyWindow = windows.find((windowInfo) => isWeeklyMenuWindow(windowInfo)) || null;
  const shortWindow = windows
    .filter((windowInfo) => !isWeeklyMenuWindow(windowInfo))
    .sort(compareMenuWindows)[0] || null;
  const fallbackWindow = windows.sort(compareMenuWindows)[0] || null;
  const planType = String(profile?.planType || usageData?.planType || "").toLowerCase();
  let selectedWindow = fallbackWindow;

  if (planType === "plus" && weeklyWindow && shortWindow) {
    const weeklyRemaining = clampMenuPercent(weeklyWindow.remainingPercent);
    selectedWindow = weeklyRemaining != null && weeklyRemaining <= PLUS_WEEKLY_ALERT_THRESHOLD
      ? weeklyWindow
      : shortWindow;
  }

  const summaryWindow = usageData?.summary || null;
  const remainingPercent =
    clampMenuPercent(selectedWindow?.remainingPercent) ??
    clampMenuPercent(profile?.priority?.remainingPercent) ??
    clampMenuPercent(summaryWindow?.remainingPercent) ??
    previousProfile?.remainingPercent ??
    null;
  const resetAt =
    selectedWindow?.resetAt ||
    profile?.priority?.resetAt ||
    summaryWindow?.resetAt ||
    previousProfile?.resetAt ||
    null;
  const blocked = profile?.usage?.data?.blocked === true
    || profile?.priority?.usable === false
    || remainingPercent === 0;

  return {
    remainingPercent,
    resetAt,
    blocked
  };
}

function formatMenuResetAt(value) {
  if (!value) {
    return "重置未知";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "重置未知";
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatMenuPlan(planType) {
  if (!planType) {
    return "UNKNOWN";
  }
  return String(planType).toUpperCase();
}

function buildProfilesSubmenu() {
  if (menuProfilesError) {
    return [
      {
        label: "账号列表读取失败",
        sublabel: menuProfilesError,
        enabled: false
      }
    ];
  }

  if (!menuProfilesSnapshot.length) {
    return [
      {
        label: "暂无账号",
        enabled: false
      }
    ];
  }

  return menuProfilesSnapshot.map((profile) => {
    const remainingPercent = Number.isFinite(profile.remainingPercent) ? `${profile.remainingPercent}%` : "--";
    const resetLabel = formatMenuResetAt(profile.resetAt);
    const planLabel = formatMenuPlan(profile.planType);

    return {
      type: "radio",
      label: profile.profileName,
      checked: profile.active === true,
      sublabel: `${planLabel} · ${remainingPercent} · ${resetLabel}`,
      click: () => {
        switchToProfileFromMenu(profile.profileName).catch((error) => {
          dialog.showErrorBox("Codex Switch Menubar", error.message);
        });
      }
    };
  });
}

function buildVersionSubmenu() {
  const currentLabel = appVersionSnapshot?.currentVersionLabel || `v${app.getVersion()}`;
  const items = [
    {
      label: `当前版本 ${currentLabel}`,
      enabled: false
    },
    {
      type: "checkbox",
      label: "自动检查更新",
      checked: shellState.autoUpdateChecks.enabled,
      click: (menuItem) => {
        shellState.autoUpdateChecks.enabled = menuItem.checked;
        saveShellState().catch(() => {});
        if (menuItem.checked) {
          triggerAppVersionRefresh({ forceRefresh: true });
          startAppVersionRefreshLoop();
        } else {
          stopAppVersionRefreshLoop();
          syncOverlayUpdateNotice();
          refreshTrayMenu();
        }
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.reloadIgnoringCache();
        }
      }
    },
    {
      label: "检查更新",
      click: () => {
        checkForUpdatesFromMenu().catch((error) => {
          dialog.showErrorBox("Codex Switch", error.message);
        });
      }
    }
  ];

  if (appVersionError) {
    items.push({
      label: "更新检查失败",
      sublabel: appVersionError,
      enabled: false
    });
    return items;
  }

  if (appVersionSnapshot?.install?.inFlight) {
    items.push({
      label: "正在安装更新",
      sublabel: appVersionSnapshot.install.message || "后台下载并替换当前应用",
      enabled: false
    });
  } else if (appVersionSnapshot?.install?.phase === "failed" && appVersionSnapshot?.install?.error) {
    items.push({
      label: "更新失败",
      sublabel: appVersionSnapshot.install.error,
      enabled: false
    });
  } else if (appVersionSnapshot?.update?.available) {
    items.push({
      label: `安装 ${appVersionSnapshot.update.latestVersionLabel}`,
      sublabel: appVersionSnapshot.update.assetName || "下载并替换当前安装",
      click: () => {
        installUpdateFromMenu().catch((error) => {
          dialog.showErrorBox("Codex Switch", error.message);
        });
      }
    });
  } else if (appVersionSnapshot?.update?.ok) {
    items.push({
      label: "已是最新版本",
      sublabel: appVersionSnapshot.update.latestVersionLabel || "暂无可安装更新",
      enabled: false
    });
  }

  return items;
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: "打开控制台",
      click: () => openDashboardWindow()
    },
    {
      label: "启动 Codex",
      click: () => {
        openCodexDesktopApp().catch((error) => {
          dialog.showErrorBox("Codex Switch Menubar", error.message);
        });
      }
    },
    {
      label: "账号列表",
      submenu: buildProfilesSubmenu()
    },
    {
      type: "checkbox",
      label: "显示悬浮额度",
      checked: shellState.overlay.enabled,
      click: () => toggleOverlayEnabled()
    },
    {
      type: "checkbox",
      label: "开机自启",
      checked: isLaunchAtLoginEnabled(),
      enabled: process.platform === "darwin",
      click: (menuItem) => {
        setLaunchAtLogin(menuItem.checked);
        refreshTrayMenu();
      }
    },
    { type: "separator" },
    {
      label: "重新连接本地服务",
      click: async () => {
        try {
          await ensureServerRunning();
          if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.reloadIgnoringCache();
          }
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.reloadIgnoringCache();
          }
        } catch (error) {
          dialog.showErrorBox("Codex Switch Menubar", error.message);
        }
      }
    },
    {
      label: "在浏览器中打开",
      click: () => shell.openExternal(BASE_URL)
    },
    {
      label: "版本与更新",
      submenu: buildVersionSubmenu()
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
}

function showContextMenu(targetWindow = null) {
  const menu = buildContextMenu();
  menu.popup(targetWindow ? { window: targetWindow } : {});
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  tray.setTitle("Codex");
  tray.setToolTip("Codex Switch");
  tray.setContextMenu(buildContextMenu());
}

function configureWebContents(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalAppUrl(url)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function getDefaultOverlayPosition() {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  return {
    x: Math.round(workArea.x + workArea.width - OVERLAY_COLLAPSED_NOTICE_SIZE.width - 18),
    y: Math.round(workArea.y + 78)
  };
}

function getOverlayPosition() {
  if (Number.isFinite(shellState.overlay.x) && Number.isFinite(shellState.overlay.y)) {
    return {
      x: shellState.overlay.x,
      y: shellState.overlay.y
    };
  }
  return getDefaultOverlayPosition();
}

async function isServerReachable(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(getHealthUrl(), { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.on("error", () => {
      resolve(false);
    });
  });
}

async function postLocalJson(pathname, body = {}) {
  await ensureServerRunning();

  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": payload.length
      }
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getLocalJson(pathname) {
  await ensureServerRunning();

  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: HOST,
      port: PORT,
      path: pathname
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
  });
}

async function ensureServerRunning() {
  if (await isServerReachable()) {
    return;
  }

  const serverModule = getBundledServerModule();
  if (typeof serverModule?.startServer !== "function") {
    throw new Error(`Menu bar app could not load bundled server from ${app.getAppPath()}`);
  }

  await serverModule.startServer();

  for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
    if (await isServerReachable()) {
      return;
    }
    await sleep(STARTUP_DELAY_MS);
  }

  throw new Error(`Menu bar app could not reach ${getHealthUrl()}`);
}

function getOverlayTargetSize({ expanded = overlayExpanded, hasUpdateNotice = overlayHasUpdateNotice } = {}) {
  if (expanded) {
    return hasUpdateNotice ? OVERLAY_EXPANDED_NOTICE_SIZE : OVERLAY_EXPANDED_SIZE;
  }
  return hasUpdateNotice ? OVERLAY_COLLAPSED_NOTICE_SIZE : OVERLAY_COLLAPSED_SIZE;
}

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: DASHBOARD_SIZE.width,
    height: DASHBOARD_SIZE.height,
    minWidth: 980,
    minHeight: 700,
    title: "Codex Switch Dashboard",
    backgroundColor: "#eef3ff",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  configureWebContents(dashboardWindow);
  dashboardWindow.loadURL(BASE_URL);

  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
    refreshTrayMenu();
  });
}

async function openCodexDesktopApp() {
  const result = await postLocalJson("/api/open/codex");
  if (!result?.ok) {
    throw new Error(result?.message || result?.error || "Failed to open Codex");
  }
  return result;
}

async function updateMenuProfilesSnapshot() {
  if (menuProfilesRefreshInFlight) {
    return menuProfilesRefreshInFlight;
  }

  menuProfilesRefreshInFlight = (async () => {
    try {
      const state = await getLocalJson("/api/state");
      const previousByName = new Map(menuProfilesSnapshot.map((profile) => [profile.profileName, profile]));
      menuProfilesSnapshot = Array.isArray(state?.profiles)
        ? state.profiles.map((profile) => {
            const previousProfile = previousByName.get(profile.profileName) || {};
            const usageState = resolveMenuUsageState(profile, previousProfile);
            return {
              ...previousProfile,
              profileName: profile.profileName,
              active: profile.active === true,
              planType: profile.planType || profile.usage?.data?.planType || null,
              remainingPercent: usageState.remainingPercent,
              resetAt: usageState.resetAt,
              blocked: usageState.blocked,
              issue: profile.usage?.issue?.message || (profile.usage?.ok === false ? (profile.usage?.error || "额度异常") : null)
            };
          })
        : [];
      menuProfilesError = null;
    } catch (error) {
      if (!menuProfilesSnapshot.length) {
        menuProfilesError = error.message || "未知错误";
      }
    } finally {
      menuProfilesRefreshInFlight = null;
    }
  })();

  return menuProfilesRefreshInFlight;
}

async function updateAppVersionSnapshot({ forceRefresh = false } = {}) {
  if (appVersionRefreshInFlight) {
    return appVersionRefreshInFlight;
  }

  appVersionRefreshInFlight = (async () => {
    try {
      const result = forceRefresh
        ? await postLocalJson("/api/app/update/check")
        : await getLocalJson("/api/app/version");
      appVersionSnapshot = result?.app || null;
      appVersionError = null;
    } catch (error) {
      appVersionSnapshot = null;
      appVersionError = error.message || "未知错误";
    } finally {
      appVersionRefreshInFlight = null;
    }
    return appVersionSnapshot;
  })();

  return appVersionRefreshInFlight;
}

function syncOverlayUpdateNotice() {
  const shouldShow = Boolean(
    shellState.autoUpdateChecks.enabled &&
    appVersionSnapshot?.packaged &&
    appVersionSnapshot?.update?.available &&
    !appVersionSnapshot?.install?.inFlight
  );
  if (shouldShow === overlayHasUpdateNotice) {
    return;
  }
  setOverlayUpdateNoticeVisible(shouldShow).catch(() => {});
}

async function checkForUpdatesFromMenu() {
  const snapshot = await updateAppVersionSnapshot({ forceRefresh: true });
  syncOverlayUpdateNotice();
  refreshTrayMenu();

  if (!snapshot?.update?.ok) {
    throw new Error(snapshot?.update?.error || appVersionError || "检查更新失败");
  }

  if (snapshot.update.available) {
    await dialog.showMessageBox({
      type: "info",
      buttons: ["知道了"],
      message: `发现新版本 ${snapshot.update.latestVersionLabel}`,
      detail: snapshot.update.assetName || "可直接下载安装更新"
    });
    return;
  }

  await dialog.showMessageBox({
    type: "info",
    buttons: ["知道了"],
    message: `当前已是最新版本 ${snapshot.currentVersionLabel}`
  });
}

async function installUpdateFromMenu() {
  const snapshot = await updateAppVersionSnapshot({ forceRefresh: true });
  syncOverlayUpdateNotice();
  refreshTrayMenu();

  if (!snapshot?.update?.ok) {
    throw new Error(snapshot?.update?.error || appVersionError || "检查更新失败");
  }

  if (!snapshot.update.available) {
    await dialog.showMessageBox({
      type: "info",
      buttons: ["知道了"],
      message: `当前已是最新版本 ${snapshot.currentVersionLabel}`
    });
    return;
  }

  if (snapshot.install?.inFlight) {
    await dialog.showMessageBox({
      type: "info",
      buttons: ["知道了"],
      message: "更新已经在后台进行中",
      detail: snapshot.install.message || "请等待下载和安装完成"
    });
    return;
  }

  const confirmation = await dialog.showMessageBox({
    type: "question",
    buttons: ["安装更新", "取消"],
    defaultId: 0,
    cancelId: 1,
    message: `安装 ${snapshot.update.latestVersionLabel}`,
    detail: "将下载最新 DMG，退出当前应用，替换 /Applications 中的安装并自动重启。"
  });

  if (confirmation.response !== 0) {
    return;
  }

  const result = await postLocalJson("/api/app/update/install", {});
  if (!result?.ok) {
    throw new Error(result?.message || result?.error || "安装更新失败");
  }
  await updateAppVersionSnapshot({ forceRefresh: false });
  syncOverlayUpdateNotice();
  refreshTrayMenu();
}

function triggerAppVersionRefresh({ forceRefresh = false } = {}) {
  if (!forceRefresh && !shellState.autoUpdateChecks.enabled) {
    syncOverlayUpdateNotice();
    refreshTrayMenu();
    return;
  }
  updateAppVersionSnapshot({ forceRefresh })
    .then(() => {
      syncOverlayUpdateNotice();
      refreshTrayMenu();
    })
    .catch(() => {});
}

function triggerMenuProfilesRefresh() {
  updateMenuProfilesSnapshot()
    .then(() => {
      refreshTrayMenu();
    })
    .catch(() => {});
}

function startAppVersionRefreshLoop() {
  stopAppVersionRefreshLoop();
  if (!shellState.autoUpdateChecks.enabled) {
    return;
  }
  appVersionRefreshTimer = setInterval(() => {
    triggerAppVersionRefresh({ forceRefresh: false });
  }, APP_VERSION_REFRESH_MS);
}

function stopAppVersionRefreshLoop() {
  if (!appVersionRefreshTimer) {
    return;
  }
  clearInterval(appVersionRefreshTimer);
  appVersionRefreshTimer = null;
}

function startMenuProfilesRefreshLoop() {
  if (menuProfilesRefreshTimer) {
    clearInterval(menuProfilesRefreshTimer);
  }
  menuProfilesRefreshTimer = setInterval(() => {
    triggerMenuProfilesRefresh();
  }, 15000);
}

function stopMenuProfilesRefreshLoop() {
  if (!menuProfilesRefreshTimer) {
    return;
  }
  clearInterval(menuProfilesRefreshTimer);
  menuProfilesRefreshTimer = null;
}

async function switchToProfileFromMenu(profileName) {
  const result = await postLocalJson("/api/profile/use", {
    name: profileName,
    closeAndForce: true,
    openCodex: true
  });

  if (!result?.ok) {
    throw new Error(result?.message || result?.error || `Failed to switch profile: ${profileName}`);
  }

  await updateMenuProfilesSnapshot();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.reloadIgnoringCache();
  }
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.reloadIgnoringCache();
  }
  refreshTrayMenu();
  return result;
}

function prepareAndShowContextMenu(targetWindow = null) {
  showContextMenu(targetWindow);
  triggerMenuProfilesRefresh();
  if (shellState.autoUpdateChecks.enabled) {
    triggerAppVersionRefresh({ forceRefresh: false });
  }
}

function createOverlayWindow() {
  const position = getOverlayPosition();
  overlayExpanded = false;
  overlayHasUpdateNotice = Boolean(
    shellState.autoUpdateChecks.enabled &&
    appVersionSnapshot?.packaged &&
    appVersionSnapshot?.update?.available
  );
  const initialSize = getOverlayTargetSize();

  overlayWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    x: position.x,
    y: position.y,
    minWidth: OVERLAY_COLLAPSED_SIZE.width,
    minHeight: OVERLAY_COLLAPSED_SIZE.height,
    maxWidth: OVERLAY_EXPANDED_SIZE.width,
    maxHeight: OVERLAY_EXPANDED_NOTICE_SIZE.height,
    frame: false,
    show: false,
    title: "Codex Switch Overlay",
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    visualEffectState: "active",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(app.getAppPath(), "electron", "preload.js")
    }
  });

  overlayWindow.loadFile(path.join(app.getAppPath(), "electron", "overlay.html"));
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setAlwaysOnTop(true, "floating", 1);
  overlayWindow.setContentProtection(false);

  overlayWindow.on("move", queueOverlayBoundsSave);
  overlayWindow.on("closed", () => {
    overlayWindow = null;
    overlayExpanded = false;
    overlayHasUpdateNotice = false;
    refreshTrayMenu();
  });
  overlayWindow.on("close", (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    hideOverlayWindow({ persist: true }).catch(() => {});
  });
}

async function openDashboardWindow() {
  await ensureServerRunning();

  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    createDashboardWindow();
  }

  if (dashboardWindow.isMinimized()) {
    dashboardWindow.restore();
  }
  dashboardWindow.show();
  dashboardWindow.focus();
  refreshTrayMenu();
}

async function showOverlayWindow() {
  await ensureServerRunning();

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }

  shellState.overlay.enabled = true;
  await saveShellState();
  await setOverlayExpanded(false);

  overlayWindow.showInactive();
  refreshTrayMenu();
}

async function hideOverlayWindow({ persist = true } = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    shellState.overlay.enabled = false;
    if (persist) {
      await saveShellState();
    }
    refreshTrayMenu();
    return;
  }

  const windowRef = overlayWindow;
  overlayWindow = null;
  overlayExpanded = false;
  if (persist) {
    shellState.overlay.enabled = false;
    await saveShellState();
  }
  windowRef.removeAllListeners("close");
  windowRef.destroy();
  refreshTrayMenu();
}

async function toggleOverlayEnabled() {
  if (shellState.overlay.enabled) {
    await hideOverlayWindow({ persist: true });
    return;
  }
  await showOverlayWindow();
}

async function setOverlayExpanded(expanded) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }

  const nextExpanded = Boolean(expanded);
  const targetSize = getOverlayTargetSize({
    expanded: nextExpanded,
    hasUpdateNotice: overlayHasUpdateNotice
  });
  const currentBounds = overlayWindow.getBounds();
  const boundsUnchanged =
    overlayExpanded === nextExpanded &&
    currentBounds.width === targetSize.width &&
    currentBounds.height === targetSize.height;

  if (boundsUnchanged) {
    return true;
  }

  const position = clampWindowToWorkArea(
    currentBounds.x,
    currentBounds.y + currentBounds.height - targetSize.height,
    targetSize.width,
    targetSize.height
  );

  overlayExpanded = nextExpanded;
  overlayWindow.setBounds({
    x: position.x,
    y: position.y,
    width: targetSize.width,
    height: targetSize.height
  }, true);
  refreshTrayMenu();
  return true;
}

async function setOverlayUpdateNoticeVisible(visible) {
  overlayHasUpdateNotice = Boolean(visible);
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return true;
  }
  return setOverlayExpanded(overlayExpanded);
}

function cleanupServerProcess() {
  stopMenuProfilesRefreshLoop();
  stopAppVersionRefreshLoop();
}

async function bootstrap() {
  await ensureServerRunning();
  await loadShellState();
  await updateMenuProfilesSnapshot();
  await updateAppVersionSnapshot({ forceRefresh: false });
  syncOverlayUpdateNotice();
  startMenuProfilesRefreshLoop();
  startAppVersionRefreshLoop();

  app.setName("Codex Switch");
  app.name = "Codex Switch";
  app.setAboutPanelOptions({
    applicationName: "Codex Switch",
    applicationVersion: app.getVersion()
  });

  if (process.platform === "darwin") {
    app.dock.hide();
    app.setActivationPolicy("accessory");
  }

  tray = new Tray(createTrayIcon());
  tray.setTitle("Codex");
  tray.setToolTip("Codex Switch");
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", () => {
    try {
      prepareAndShowContextMenu();
    } catch (error) {
      dialog.showErrorBox("Codex Switch Menubar", error.message);
    }
  });
  tray.on("right-click", () => {
    try {
      prepareAndShowContextMenu();
    } catch (error) {
      dialog.showErrorBox("Codex Switch Menubar", error.message);
    }
  });
  refreshTrayMenu();

  if (shellState.overlay.enabled) {
    await showOverlayWindow();
  }
}

ipcMain.handle("shell:get-base-url", () => BASE_URL);
ipcMain.handle("shell:get-auto-update-checks-enabled", () => shellState.autoUpdateChecks.enabled);
ipcMain.handle("shell:open-dashboard", async () => {
  await openDashboardWindow();
  return true;
});
ipcMain.handle("shell:hide-overlay", async () => {
  await hideOverlayWindow({ persist: true });
  return true;
});
ipcMain.handle("shell:set-overlay-expanded", async (_event, expanded) => {
  return setOverlayExpanded(expanded);
});
ipcMain.handle("shell:get-overlay-bounds", () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return null;
  }
  return overlayWindow.getBounds();
});
ipcMain.handle("shell:set-overlay-position", async (_event, x, y) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }
  const bounds = overlayWindow.getBounds();
  const position = clampWindowToWorkArea(Number(x) || bounds.x, Number(y) || bounds.y, bounds.width, bounds.height);
  overlayWindow.setPosition(position.x, position.y, false);
  queueOverlayBoundsSave();
  return true;
});
ipcMain.handle("shell:set-overlay-update-notice-visible", async (_event, visible) => {
  return setOverlayUpdateNoticeVisible(visible);
});
ipcMain.handle("shell:show-context-menu", () => {
  prepareAndShowContextMenu(overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null);
  return true;
});

app.name = "Codex Switch Menubar";
app.on("before-quit", () => {
  quitting = true;
  cleanupServerProcess();
});
process.on("exit", cleanupServerProcess);

app.whenReady()
  .then(bootstrap)
  .catch((error) => {
    dialog.showErrorBox("Codex Switch Menubar", error.message);
    app.quit();
  });

app.on("activate", () => {
  refreshTrayMenu();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
