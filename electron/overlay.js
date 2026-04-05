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

let baseUrl = "";
let expanded = false;
let collapseTimer = null;
let dragState = null;
let pendingDragFrame = null;
let updateState = {
  visible: false
};
let lastRenderableUsage = null;
let dismissedUsageNoticeKey = null;
const PLUS_WEEKLY_ALERT_THRESHOLD = 10;

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getUsageTone(percent) {
  if (percent <= 10) return "danger";
  if (percent <= 35) return "warn";
  return "good";
}

function getUsageLabel(percent) {
  if (percent <= 0) return "已耗尽";
  if (percent <= 10) return "很低";
  if (percent <= 35) return "偏低";
  if (percent <= 70) return "可用";
  return "充足";
}

function getOverlayWindows(usage) {
  if (!usage || usage.ok === false || !usage.data) {
    return [];
  }
  return [usage.data.primary, usage.data.secondary].filter(
    (windowInfo) => windowInfo && windowInfo.remainingPercent != null
  );
}

function isWeeklyWindow(windowInfo) {
  if (!windowInfo) return false;
  if (Number.isFinite(windowInfo.windowDurationMins) && windowInfo.windowDurationMins >= (6 * 24 * 60)) {
    return true;
  }
  return /week/i.test(String(windowInfo.label || ""));
}

function compareOverlayWindows(a, b) {
  const remainingA = clampPercent(a?.remainingPercent);
  const remainingB = clampPercent(b?.remainingPercent);
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

function getOverlayWindowLabel(windowInfo) {
  if (!windowInfo) return "额度";
  if (isWeeklyWindow(windowInfo)) return "周额度";

  const minutes = Number.isFinite(windowInfo.windowDurationMins) ? windowInfo.windowDurationMins : null;
  if (minutes != null && minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours}小时`;
  }
  if (minutes != null && minutes > 0) {
    return `${minutes}分钟`;
  }
  return String(windowInfo.label || "额度");
}

function pickOverlayWindow(usage) {
  const windows = getOverlayWindows(usage);
  if (!windows.length) {
    return usage?.data?.summary || null;
  }

  const weeklyWindow = windows.find((windowInfo) => isWeeklyWindow(windowInfo)) || null;
  const shortWindow = windows
    .filter((windowInfo) => !isWeeklyWindow(windowInfo))
    .sort(compareOverlayWindows)[0] || null;
  const planType = String(usage?.data?.planType || "").toLowerCase();

  if (planType === "plus" && weeklyWindow && shortWindow) {
    const weeklyRemaining = clampPercent(weeklyWindow.remainingPercent);
    if (weeklyRemaining <= PLUS_WEEKLY_ALERT_THRESHOLD) {
      return weeklyWindow;
    }
    return shortWindow;
  }

  return [...windows].sort(compareOverlayWindows)[0];
}

function getUsageSummary(usage) {
  if (!usage) {
    return { percent: null, tone: "warn", resetAt: null, issue: "还没有拿到额度数据", blocked: false, label: "额度" };
  }
  if (usage.ok === false) {
    return { percent: null, tone: "danger", resetAt: null, issue: usage.error || "额度读取失败", blocked: true, label: "额度" };
  }

  const windowInfo = pickOverlayWindow(usage);
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
    label: getOverlayWindowLabel(windowInfo)
  };
}

function hasRenderableUsage(usage) {
  return Boolean(usage && usage.ok !== false && usage.data?.summary && usage.data.summary.remainingPercent != null);
}

function getDisplayUsage(usage) {
  if (hasRenderableUsage(usage)) {
    if (usage.fallback !== true) {
      lastRenderableUsage = {
        ok: true,
        data: usage.data,
        rawFetchedAt: usage.rawFetchedAt || null
      };
    }
    return usage;
  }
  if (lastRenderableUsage) {
    return {
      ok: true,
      data: lastRenderableUsage.data,
      rawFetchedAt: lastRenderableUsage.rawFetchedAt || null,
      fallback: true,
      issue: {
        level: "warn",
        message: usage?.issue?.message || usage?.error || "当前读取失败，正在显示上次成功数据"
      }
    };
  }
  return usage;
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
    ? "额度已连续 5 分钟读取失败，继续显示旧数据"
    : "额度已连续 5 分钟读取失败，请检查网络";
  usageBannerCloseEl.dataset.noticeKey = noticeKey;
  usageBannerEl.classList.remove("hidden");
}

function formatResetTime(value) {
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

async function fetchState() {
  const response = await fetch(`${baseUrl}/api/state`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch app state");
  }
  return response.json();
}

async function fetchVersionState() {
  const response = await fetch(`${baseUrl}/api/app/version`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch app version");
  }
  return response.json();
}

async function installUpdate() {
  const response = await fetch(`${baseUrl}/api/app/update/install`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.message || "安装更新失败");
  }
  return data;
}

async function setExpanded(nextExpanded) {
  if (expanded === nextExpanded) {
    return;
  }
  expanded = nextExpanded;
  document.body.dataset.expanded = nextExpanded ? "true" : "false";
  await window.codexShell.setOverlayExpanded(nextExpanded);
}

function scheduleCollapse() {
  clearTimeout(collapseTimer);
  collapseTimer = window.setTimeout(() => {
    setExpanded(false).catch(() => {});
  }, 120);
}

async function refresh() {
  try {
    const state = await fetchState();
    const displayUsage = getDisplayUsage(state.activeUsage);
    const usage = getUsageSummary(displayUsage);
    const activeAccount = state.activeAccount || {};

    quotaPercentEl.textContent = usage.percent == null ? "--%" : `${usage.percent}%`;
    quotaPercentEl.title = usage.percent == null ? (usage.issue || "额度状态未知") : `${usage.blocked ? "当前不可用" : getUsageLabel(usage.percent)} · ${usage.percent}%`;
    quotaLabelEl.textContent = usage.percent == null ? "异常" : (usage.blocked ? "不可用" : getUsageLabel(usage.percent));
    quotaLabelEl.title = usage.issue || quotaLabelEl.textContent;
    resetTimeEl.textContent = formatResetTime(usage.resetAt);
    resetTimeEl.title = usage.issue ? `${usage.issue} · 重置 ${formatResetTime(usage.resetAt)}` : `重置 ${formatResetTime(usage.resetAt)}`;
    accountNameEl.textContent = activeAccount.email || activeAccount.displayName || state.activeProfile || "未识别账号";
    accountNameEl.title = usage.issue || accountNameEl.textContent;
    document.documentElement.style.setProperty("--progress", `${usage.percent == null ? 0 : usage.percent}%`);
    document.body.dataset.tone = usage.tone;
    renderUsageBanner(state.activeProfile || activeAccount.email || "unknown", displayUsage);
  } catch {
    quotaPercentEl.textContent = "--%";
    quotaLabelEl.textContent = "异常";
    resetTimeEl.textContent = "重置未知";
    resetTimeEl.title = "重置未知";
    accountNameEl.textContent = "额度读取失败";
    document.documentElement.style.setProperty("--progress", "0%");
    document.body.dataset.tone = "danger";
    usageBannerEl.classList.add("hidden");
  }
}

async function refreshVersion() {
  try {
    const autoChecksEnabled = await window.codexShell.getAutoUpdateChecksEnabled();
    const result = await fetchVersionState();
    const appState = result.app;
    const update = appState?.update;
    const visible = Boolean(autoChecksEnabled && appState?.packaged && update?.available);
    updateState.visible = visible;

    if (visible) {
      updateBannerTextEl.textContent = `发现 ${update.latestVersionLabel}`;
      updateBannerButtonEl.disabled = false;
      updateBannerEl.classList.remove("hidden");
    } else {
      updateBannerEl.classList.add("hidden");
    }

    await window.codexShell.setOverlayUpdateNoticeVisible(visible);
  } catch {
    updateState.visible = false;
    updateBannerEl.classList.add("hidden");
    await window.codexShell.setOverlayUpdateNoticeVisible(false);
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
  const bounds = await window.codexShell.getOverlayBounds();
  if (!bounds) {
    return;
  }

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
  if (!dragState || pendingDragFrame) {
    return;
  }

  pendingDragFrame = window.requestAnimationFrame(async () => {
    pendingDragFrame = null;
    if (!dragState) {
      return;
    }
    await window.codexShell.setOverlayPosition(dragState.nextX, dragState.nextY);
  });
}

hideButtonEl.addEventListener("click", async (event) => {
  event.stopPropagation();
  await window.codexShell.hideOverlay();
});

usageBannerCloseEl.addEventListener("click", (event) => {
  event.stopPropagation();
  dismissedUsageNoticeKey = usageBannerCloseEl.dataset.noticeKey || null;
  usageBannerEl.classList.add("hidden");
});

updateBannerButtonEl.addEventListener("click", async (event) => {
  event.stopPropagation();
  if (!updateState.visible) {
    return;
  }
  updateBannerButtonEl.disabled = true;
  updateBannerButtonEl.textContent = "更新中";
  updateBannerTextEl.textContent = "正在安装更新…";
  try {
    await installUpdate();
  } catch (error) {
    updateBannerTextEl.textContent = error.message || "更新失败";
    updateBannerButtonEl.disabled = false;
    updateBannerButtonEl.textContent = "重试";
  }
});

document.body.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest("#hideButton") || event.target.closest("#updateBannerButton") || event.target.closest("#usageBannerClose")) {
    return;
  }
  event.preventDefault();
  beginDrag(event).catch(() => {});
});

window.addEventListener("mousemove", (event) => {
  if (!dragState) {
    return;
  }
  dragState.nextX = dragState.startX + (event.screenX - dragState.startMouseX);
  dragState.nextY = dragState.startY + (event.screenY - dragState.startMouseY);
  queueDragUpdate();
});

window.addEventListener("mouseup", () => {
  stopDrag();
});

document.body.addEventListener("contextmenu", async (event) => {
  event.preventDefault();
  await window.codexShell.showContextMenu();
});

document.body.addEventListener("mouseenter", () => {
  clearTimeout(collapseTimer);
  setExpanded(true).catch(() => {});
});

document.body.addEventListener("mouseleave", () => {
  if (!dragState) {
    scheduleCollapse();
  }
});

(async () => {
  baseUrl = await window.codexShell.getBaseUrl();
  document.body.dataset.expanded = "false";
  document.body.dataset.dragging = "false";
  await refresh();
  await refreshVersion();
  window.setInterval(refresh, 5000);
  window.setInterval(refreshVersion, 60 * 1000);
})();
