const quotaPercentEl = document.querySelector("#quotaPercent");
const quotaLabelEl = document.querySelector("#quotaLabel");
const resetTimeEl = document.querySelector("#resetTime");
const hideButtonEl = document.querySelector("#hideButton");
const accountNameEl = document.querySelector("#accountName");
const updateBannerEl = document.querySelector("#updateBanner");
const updateBannerTextEl = document.querySelector("#updateBannerText");
const updateBannerButtonEl = document.querySelector("#updateBannerButton");

let baseUrl = "";
let expanded = false;
let collapseTimer = null;
let dragState = null;
let pendingDragFrame = null;
let updateState = {
  visible: false
};

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

function getUsageSummary(usage) {
  if (!usage) {
    return { percent: 0, tone: "warn", resetAt: null };
  }
  if (usage.ok === false) {
    return { percent: 0, tone: "danger", resetAt: null };
  }

  const summary = usage.data?.summary;
  if (!summary || summary.remainingPercent == null) {
    return { percent: 0, tone: "warn", resetAt: null };
  }

  const percent = clampPercent(summary.remainingPercent);
  return {
    percent,
    tone: getUsageTone(percent),
    resetAt: summary.resetAt || null
  };
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
    const usage = getUsageSummary(state.activeUsage);
    const activeAccount = state.activeAccount || {};

    quotaPercentEl.textContent = `${usage.percent}%`;
    quotaPercentEl.title = `${getUsageLabel(usage.percent)} · ${usage.percent}%`;
    quotaLabelEl.textContent = getUsageLabel(usage.percent);
    resetTimeEl.textContent = formatResetTime(usage.resetAt);
    resetTimeEl.title = `重置 ${formatResetTime(usage.resetAt)}`;
    accountNameEl.textContent = activeAccount.email || activeAccount.displayName || state.activeProfile || "未识别账号";
    document.documentElement.style.setProperty("--progress", `${usage.percent}%`);
    document.body.dataset.tone = usage.tone;
  } catch {
    quotaPercentEl.textContent = "--%";
    quotaLabelEl.textContent = "异常";
    resetTimeEl.textContent = "重置未知";
    resetTimeEl.title = "重置未知";
    accountNameEl.textContent = "额度读取失败";
    document.documentElement.style.setProperty("--progress", "0%");
    document.body.dataset.tone = "danger";
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
  if (event.button !== 0 || event.target.closest("#hideButton") || event.target.closest("#updateBannerButton")) {
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
