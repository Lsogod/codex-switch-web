const quotaPercentEl = document.querySelector("#quotaPercent");
const quotaLabelEl = document.querySelector("#quotaLabel");
const resetTimeEl = document.querySelector("#resetTime");
const hideButtonEl = document.querySelector("#hideButton");
const accountNameEl = document.querySelector("#accountName");

let baseUrl = "";
let expanded = false;
let collapseTimer = null;
let dragState = null;
let pendingDragFrame = null;

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

document.body.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest("#hideButton")) {
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
  window.setInterval(refresh, 5000);
})();
