const quotaPercentEl = document.querySelector("#quotaPercent");
const quotaLabelEl = document.querySelector("#quotaLabel");
const resetTimeEl = document.querySelector("#resetTime");
const hideButtonEl = document.querySelector("#hideButton");
const accountNameEl = document.querySelector("#accountName");
const updateBannerEl = document.querySelector("#updateBanner");
const updateBannerTextEl = document.querySelector("#updateBannerText");
const updateBannerButtonEl = document.querySelector("#updateBannerButton");
const usageBannerEl = document.querySelector("#usageBanner");
const usageBannerTextEl = document.querySelector("#usageBannerText");
const usageBannerCloseEl = document.querySelector("#usageBannerClose");

let expanded = false;
let hasUpdateNotice = false;
let collapseTimer = null;
let dragState = null;
let pendingDragFrame = null;
let dismissedUsageNoticeKey = null;
const usageCacheByProfile = new Map();

const PLUS_WEEKLY_ALERT_THRESHOLD = 10;

async function shellGet(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(path);
  return response.json();
}

async function shellPost(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(path);
  return response.json();
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getUsageTone(percent) {
  if (percent == null) return "warn";
  if (percent <= 10) return "danger";
  if (percent <= 35) return "warn";
  return "good";
}

function getUsageLabel(percent) {
  if (percent == null) return "异常";
  if (percent <= 0) return "已耗尽";
  if (percent <= 10) return "很低";
  if (percent <= 35) return "偏低";
  if (percent <= 70) return "可用";
  return "充足";
}

function getUsageWindows(usage) {
  if (!usage || usage.ok === false || !usage.data) return [];
  return [usage.data.primary, usage.data.secondary].filter(
    (windowInfo) => windowInfo && windowInfo.remainingPercent != null
  );
}

function isWeeklyWindow(windowInfo) {
  if (!windowInfo) return false;
  if (Number.isFinite(windowInfo.windowDurationMins) && windowInfo.windowDurationMins >= 6 * 24 * 60) {
    return true;
  }
  return /week|weekly|周/i.test(String(windowInfo.label || ""));
}

function compareUsageWindows(a, b) {
  const remainingA = clampPercent(a?.remainingPercent);
  const remainingB = clampPercent(b?.remainingPercent);
  if (remainingA != null && remainingB != null && remainingA !== remainingB) return remainingA - remainingB;
  if (remainingA == null && remainingB != null) return 1;
  if (remainingA != null && remainingB == null) return -1;
  const resetA = a?.resetAt ? new Date(a.resetAt).getTime() : Number.POSITIVE_INFINITY;
  const resetB = b?.resetAt ? new Date(b.resetAt).getTime() : Number.POSITIVE_INFINITY;
  if (resetA !== resetB) return resetA - resetB;
  const durationA = Number.isFinite(a?.windowDurationMins) ? a.windowDurationMins : 0;
  const durationB = Number.isFinite(b?.windowDurationMins) ? b.windowDurationMins : 0;
  return durationB - durationA;
}

function getWindowLabel(windowInfo) {
  if (!windowInfo) return "额度";
  if (isWeeklyWindow(windowInfo)) return "周额度";
  const minutes = Number.isFinite(windowInfo.windowDurationMins) ? windowInfo.windowDurationMins : null;
  if (minutes != null && minutes >= 60) return `${Math.round(minutes / 60)}小时`;
  if (minutes != null && minutes > 0) return `${minutes}分钟`;
  return String(windowInfo.label || "额度");
}

function pickUsageWindow(usage, planType) {
  const windows = getUsageWindows(usage);
  if (!windows.length) return usage?.data?.summary || null;
  const weeklyWindow = windows.find((windowInfo) => isWeeklyWindow(windowInfo)) || null;
  const shortWindow = windows.filter((windowInfo) => !isWeeklyWindow(windowInfo)).sort(compareUsageWindows)[0] || null;
  const resolvedPlan = String(planType || usage?.data?.planType || "").toLowerCase();
  if (resolvedPlan === "plus" && weeklyWindow && shortWindow) {
    const weeklyRemaining = clampPercent(weeklyWindow.remainingPercent);
    return weeklyRemaining != null && weeklyRemaining <= PLUS_WEEKLY_ALERT_THRESHOLD ? weeklyWindow : shortWindow;
  }
  return [...windows].sort(compareUsageWindows)[0];
}

function hasRenderableUsage(usage) {
  return Boolean(usage && usage.ok !== false && usage.data?.summary && usage.data.summary.remainingPercent != null);
}

function getDisplayUsage(profileName, usage) {
  if (hasRenderableUsage(usage)) {
    if (usage.fallback !== true && profileName) {
      usageCacheByProfile.set(profileName, {
        ok: true,
        data: usage.data,
        rawFetchedAt: usage.rawFetchedAt || null
      });
    }
    return usage;
  }
  const cached = profileName ? usageCacheByProfile.get(profileName) : null;
  if (!cached) return usage;
  return {
    ok: true,
    data: cached.data,
    rawFetchedAt: cached.rawFetchedAt || null,
    fallback: true,
    issue: {
      level: "warn",
      message: usage?.issue?.message || usage?.error || "当前读取失败，显示上次成功数据"
    }
  };
}

function getUsageSummary(profile) {
  const usage = getDisplayUsage(profile?.profileName, profile?.usage);
  if (!usage) {
    return { percent: null, tone: "warn", resetAt: null, issue: "还没有拿到额度数据", blocked: false, label: "额度" };
  }
  if (usage.ok === false) {
    return { percent: null, tone: "danger", resetAt: null, issue: usage.error || "额度读取失败", blocked: true, label: "额度" };
  }
  const windowInfo = pickUsageWindow(usage, profile?.planType);
  if (!windowInfo || windowInfo.remainingPercent == null) {
    return { percent: null, tone: "warn", resetAt: null, issue: "当前账号未返回额度信息", blocked: false, label: "额度" };
  }
  const percent = clampPercent(windowInfo.remainingPercent);
  const blocked = usage.data?.blocked === true || windowInfo.blocked === true || percent <= 0;
  return {
    percent,
    tone: blocked ? "danger" : getUsageTone(percent),
    resetAt: windowInfo.resetAt || null,
    issue: usage.issue?.message || null,
    blocked,
    label: getWindowLabel(windowInfo)
  };
}

function formatResetTime(value) {
  if (!value) return "重置未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "重置未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function getUsageNoticeKey(activeProfile, usage) {
  const startedAt = usage?.issue?.startedAt;
  if (!activeProfile || !startedAt) return null;
  return `${activeProfile}:${startedAt}`;
}

function renderUsageBanner(activeProfile, usage) {
  const issue = usage?.issue;
  const noticeKey = getUsageNoticeKey(activeProfile, usage);
  if (!issue?.showNotice || !noticeKey || dismissedUsageNoticeKey === noticeKey) {
    usageBannerEl.classList.add("hidden");
    usageBannerTextEl.textContent = "";
    usageBannerCloseEl.dataset.noticeKey = "";
    return;
  }
  usageBannerTextEl.textContent = hasRenderableUsage(usage)
    ? "额度已连续 15 分钟读取失败，继续显示旧数据"
    : "额度已连续 15 分钟读取失败，请检查网络";
  usageBannerCloseEl.dataset.noticeKey = noticeKey;
  usageBannerEl.classList.remove("hidden");
}

function renderActiveUsage(state) {
  const activeProfileName = state.activeProfile || "";
  const activeProfile = Array.isArray(state.profiles)
    ? state.profiles.find((profile) => profile.profileName === activeProfileName)
    : null;
  const activeAccount = state.activeAccount || {};
  const profileForUsage = {
    profileName: activeProfileName || "active",
    planType: activeAccount.planType || activeProfile?.planType || state.activeUsage?.data?.planType,
    usage: state.activeUsage
  };
  const usage = getUsageSummary(profileForUsage);
  const percentText = usage.percent == null ? "--%" : `${usage.percent}%`;
  const labelText = usage.percent == null ? "异常" : usage.blocked ? "不可用" : getUsageLabel(usage.percent);
  const resetText = formatResetTime(usage.resetAt);
  const accountName = activeAccount.email || activeAccount.displayName || activeProfileName || "未识别账号";

  quotaPercentEl.textContent = percentText;
  quotaPercentEl.title = usage.issue || `${usage.label} ${percentText}`;
  quotaLabelEl.textContent = labelText;
  quotaLabelEl.title = usage.issue || usage.label || labelText;
  resetTimeEl.textContent = resetText;
  resetTimeEl.title = usage.issue ? `${usage.issue} · 重置 ${resetText}` : `重置 ${resetText}`;
  accountNameEl.textContent = accountName;
  accountNameEl.title = usage.issue || accountName;
  document.documentElement.style.setProperty("--progress", `${usage.percent == null ? 0 : usage.percent}%`);
  document.body.dataset.tone = usage.tone;
  renderUsageBanner(activeProfileName || accountName || "unknown", getDisplayUsage(activeProfileName, state.activeUsage));
}

async function setExpanded(nextExpanded) {
  if (expanded === nextExpanded) return;
  expanded = nextExpanded;
  document.body.dataset.expanded = nextExpanded ? "true" : "false";
  await shellPost("/api/shell/set-overlay-expanded", { expanded: nextExpanded, hasUpdateNotice });
}

function scheduleCollapse() {
  clearTimeout(collapseTimer);
  collapseTimer = window.setTimeout(() => {
    setExpanded(false).catch(() => {});
  }, 180);
}

async function refresh() {
  try {
    const state = await shellGet("/api/state");
    renderActiveUsage(state);
  } catch {
    quotaPercentEl.textContent = "--%";
    quotaLabelEl.textContent = "异常";
    resetTimeEl.textContent = "重置未知";
    accountNameEl.textContent = "额度读取失败";
    document.documentElement.style.setProperty("--progress", "0%");
    document.body.dataset.tone = "danger";
    usageBannerEl.classList.add("hidden");
  }
}

async function refreshVersion() {
  try {
    const autoChecks = await shellGet("/api/shell/auto-update-checks-enabled");
    const result = await shellGet("/api/app/version");
    const appState = result.app;
    const update = appState?.update;
    hasUpdateNotice = Boolean(autoChecks.enabled && appState?.packaged && update?.available);
    if (hasUpdateNotice) {
      updateBannerTextEl.textContent = `发现 ${update.latestVersionLabel}`;
      updateBannerButtonEl.textContent = "更新";
      updateBannerButtonEl.disabled = false;
      updateBannerEl.classList.remove("hidden");
    } else {
      updateBannerEl.classList.add("hidden");
    }
    await shellPost("/api/shell/set-overlay-update-notice-visible", { visible: hasUpdateNotice, expanded });
  } catch {
    hasUpdateNotice = false;
    updateBannerEl.classList.add("hidden");
    await shellPost("/api/shell/set-overlay-update-notice-visible", { visible: false, expanded }).catch(() => {});
  }
}

function stopDrag() {
  dragState = null;
  if (pendingDragFrame) {
    window.cancelAnimationFrame(pendingDragFrame);
    pendingDragFrame = null;
  }
  document.body.dataset.dragging = "false";
}

async function beginDrag(event) {
  const result = await shellGet("/api/shell/overlay-bounds");
  const bounds = result.bounds;
  if (!bounds) return;
  dragState = {
    startMouseX: event.screenX,
    startMouseY: event.screenY,
    startX: bounds.x,
    startY: bounds.y,
    nextX: bounds.x,
    nextY: bounds.y
  };
  document.body.dataset.dragging = "true";
}

function queueDragUpdate() {
  if (!dragState || pendingDragFrame) return;
  pendingDragFrame = window.requestAnimationFrame(async () => {
    pendingDragFrame = null;
    if (!dragState) return;
    await shellPost("/api/shell/set-overlay-position", { x: dragState.nextX, y: dragState.nextY });
  });
}

hideButtonEl.addEventListener("click", async (event) => {
  event.stopPropagation();
  await shellPost("/api/shell/hide-overlay").catch(() => {});
});

usageBannerCloseEl.addEventListener("click", (event) => {
  event.stopPropagation();
  dismissedUsageNoticeKey = usageBannerCloseEl.dataset.noticeKey || null;
  usageBannerEl.classList.add("hidden");
});

updateBannerButtonEl.addEventListener("click", async (event) => {
  event.stopPropagation();
  if (!hasUpdateNotice) return;
  updateBannerButtonEl.disabled = true;
  updateBannerButtonEl.textContent = "更新中";
  updateBannerTextEl.textContent = "正在安装更新...";
  try {
    const response = await fetch("/api/app/update/install", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || data.error || "安装更新失败");
  } catch (error) {
    updateBannerTextEl.textContent = error.message || "更新失败";
    updateBannerButtonEl.disabled = false;
    updateBannerButtonEl.textContent = "重试";
  }
});

document.body.addEventListener("mousedown", (event) => {
  if (
    event.button !== 0 ||
    event.target.closest("#hideButton") ||
    event.target.closest("#updateBannerButton") ||
    event.target.closest("#usageBannerClose")
  ) {
    return;
  }
  event.preventDefault();
  beginDrag(event).catch(() => {});
});

window.addEventListener("mousemove", (event) => {
  if (!dragState) return;
  dragState.nextX = dragState.startX + (event.screenX - dragState.startMouseX);
  dragState.nextY = dragState.startY + (event.screenY - dragState.startMouseY);
  queueDragUpdate();
});

window.addEventListener("mouseup", stopDrag);

document.body.addEventListener("contextmenu", async (event) => {
  event.preventDefault();
  await shellPost("/api/shell/show-context-menu").catch(() => {});
});

document.body.addEventListener("mouseenter", () => {
  clearTimeout(collapseTimer);
  setExpanded(true).catch(() => {});
});

document.body.addEventListener("mouseleave", () => {
  if (!dragState) scheduleCollapse();
});

document.body.dataset.expanded = "false";
document.body.dataset.dragging = "false";
refresh();
refreshVersion();
window.setInterval(refresh, 5000);
window.setInterval(refreshVersion, 60 * 1000);
