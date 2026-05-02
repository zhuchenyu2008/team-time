const SESSION_KEY = "team-time-session-v2";
const SLOT_COUNT = 48;
const SLOT_STEP = 30;
const START_MIN = 0;
const END_MIN = START_MIN + SLOT_COUNT * SLOT_STEP;
const DEFAULT_DAY_START_MIN = 8 * 60;
const DEFAULT_DAY_END_MIN = 22 * 60;
const DEFAULT_DURATION_MINUTES = 120;
const DEFAULT_TRIP_TIME = Object.freeze({
  durationMinutes: DEFAULT_DURATION_MINUTES,
  dayStartMinutes: DEFAULT_DAY_START_MIN,
  dayEndMinutes: DEFAULT_DAY_END_MIN,
});
const AUTOSYNC_INTERVAL_MS = 1000;
const MIN_HEAT_LABEL_SPAN = 4;
const SLOT_LABELS = Array.from({ length: SLOT_COUNT }, (_, index) => slotLabel(index));

const SCREEN_META = {
  availability: { icon: "event_available", title: "可用时间", subtitle: "默认空闲，点选不空闲时段" },
  heatmap: { icon: "grid_view", title: "同行人热力图", subtitle: "查看本次行程的时段重叠情况" },
  summary: { icon: "insights", title: "行程总结", subtitle: "自动推荐最佳连续时间窗口" },
};

const DEFAULT_TRIP_DATE = nextSaturday();

const appEl = document.querySelector("#app");

const state = {
  loading: true,
  busy: false,
  syncing: false,
  loggedIn: false,
  teamMode: "join",
  teamCode: "",
  userName: "",
  memberId: null,
  currentRole: "",
  ui: {
    activeScreen: "availability",
    availabilityFilter: "all",
    activeDate: DEFAULT_TRIP_DATE,
    notice: "",
  },
  draft: {
    teamName: "",
    tripDates: [DEFAULT_TRIP_DATE],
    dateDraft: DEFAULT_TRIP_DATE,
    durationMinutes: DEFAULT_TRIP_TIME.durationMinutes,
    dayStartMinutes: DEFAULT_TRIP_TIME.dayStartMinutes,
    dayEndMinutes: DEFAULT_TRIP_TIME.dayEndMinutes,
    availabilityByDate: availabilityMap([DEFAULT_TRIP_DATE]),
  },
  server: {
    teamName: "",
    tripDates: [DEFAULT_TRIP_DATE],
    durationMinutes: DEFAULT_TRIP_TIME.durationMinutes,
    dayStartMinutes: DEFAULT_TRIP_TIME.dayStartMinutes,
    dayEndMinutes: DEFAULT_TRIP_TIME.dayEndMinutes,
    members: [],
    myAvailabilityByDate: availabilityMap([DEFAULT_TRIP_DATE]),
    lastSyncedAt: "",
    snapshotKey: "",
  },
};

const view = {
  mode: "",
  refs: {},
};

let loginMessage = "";
let noticeTimer = null;
let autosyncTimer = null;
let lastSyncErrorText = "";
let lastSyncErrorAt = 0;
let activeHeatTooltipTarget = null;
let heatTooltipPinned = false;

boot();
appEl.addEventListener("click", (event) => void onClick(event));
appEl.addEventListener("pointerover", onHeatPointerOver);
appEl.addEventListener("pointerout", onHeatPointerOut);
appEl.addEventListener("focusin", onHeatFocusIn);
appEl.addEventListener("focusout", onHeatFocusOut);
appEl.addEventListener("input", onInput);
appEl.addEventListener("change", onInput);
document.addEventListener("scroll", () => hideHeatTooltip(), true);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.loggedIn) void autoSyncTick();
});
window.addEventListener("focus", () => {
  if (state.loggedIn) void autoSyncTick();
});
window.addEventListener("resize", () => hideHeatTooltip());

async function boot() {
  renderRoot();
  const session = readSession();
  if (session?.teamCode && session?.memberId) {
    try {
      const snapshot = await api(`/api/teams/${encodeURIComponent(session.teamCode)}?memberId=${session.memberId}`);
      applySnapshot(snapshot, { replaceDraft: true });
      state.loggedIn = true;
      state.ui.activeScreen = "availability";
      startAutoSync();
    } catch {
      clearSession();
      resetForLogin();
    }
  }
  state.loading = false;
  renderRoot();
}

async function onClick(event) {
  const heatTarget = event.target.closest('[data-action="show-heat-detail"]');
  if (heatTarget) {
    event.preventDefault();
    showHeatTooltip(heatTarget, { pinned: true });
    return;
  }

  if (!event.target.closest('[data-role="heat-tooltip"]')) hideHeatTooltip();

  const el = event.target.closest("[data-action]");
  if (!el) return;

  const action = el.dataset.action;

  if (action === "set-mode") {
    state.teamMode = el.dataset.mode === "create" ? "create" : "join";
    if (state.teamMode === "create" && !state.teamCode) state.teamCode = makeTeamCode();
    loginMessage = "";
    renderLoginView();
    return;
  }

  if (action === "submit-login") return handleLogin();

  if (action === "switch-screen") {
    hideHeatTooltip();
    state.ui.activeScreen = SCREEN_META[el.dataset.screen] ? el.dataset.screen : "availability";
    renderLoggedInView();
    return;
  }

  if (action === "logout") {
    stopAutoSync();
    clearSession();
    resetForLogin();
    renderRoot();
    return;
  }

  if (action === "copy-code") return copyCode();
  if (action === "download-ics") return downloadIcs();

  if (action === "go-edit") {
    state.ui.activeScreen = "availability";
    renderLoggedInView();
    return;
  }

  if (action === "add-date") {
    addDate();
    return;
  }

  if (action === "remove-date") {
    removeDate(el.dataset.date);
    return;
  }

  if (action === "set-duration") {
    const minutes = Number(el.dataset.minutes);
    if (Number.isInteger(minutes)) {
      state.draft.durationMinutes = minutes;
      ensureDraftTripTime();
      if (state.loggedIn) renderLoggedInView({ preserveScroll: true });
      else renderLoginView();
    }
    return;
  }

  if (action === "set-active-date") {
    const date = sanitizeDate(el.dataset.date);
    if (date && activeTripDates().includes(date)) {
      hideHeatTooltip();
      state.ui.activeDate = date;
      state.draft.dateDraft = date;
      ensureDraftAvailabilityDates();
      renderLoggedInView({ preserveScroll: true });
    }
    return;
  }

  if (action === "toggle-slot") {
    const index = Number(el.dataset.index);
    if (!Number.isNaN(index) && index >= 0 && index < SLOT_COUNT) {
      const availability = activeDraftAvailability();
      availability[index] = !availability[index];
      renderAvailabilityInteraction();
    }
    return;
  }

  if (action === "quick-preset") {
    applyPreset(el.dataset.preset || "");
    renderAvailabilityInteraction();
    return;
  }

  if (action === "toggle-filter") {
    state.ui.availabilityFilter = state.ui.availabilityFilter === "busy" ? "all" : "busy";
    renderAvailabilityInteraction();
  }
}

function onHeatPointerOver(event) {
  if (event.pointerType === "touch") return;
  const target = event.target.closest('[data-action="show-heat-detail"]');
  if (!target) return;
  showHeatTooltip(target, { pinned: false });
}

function onHeatPointerOut(event) {
  if (event.pointerType === "touch" || heatTooltipPinned) return;
  const target = event.target.closest('[data-action="show-heat-detail"]');
  if (!target || target !== activeHeatTooltipTarget) return;
  if (event.relatedTarget && target.contains(event.relatedTarget)) return;
  hideHeatTooltip();
}

function onHeatFocusIn(event) {
  const target = event.target.closest('[data-action="show-heat-detail"]');
  if (!target) return;
  showHeatTooltip(target, { pinned: false });
}

function onHeatFocusOut(event) {
  const target = event.target.closest('[data-action="show-heat-detail"]');
  if (!target || target !== activeHeatTooltipTarget || heatTooltipPinned) return;
  hideHeatTooltip();
}

function showHeatTooltip(target, options = {}) {
  const tooltip = view.refs.screen?.querySelector('[data-role="heat-tooltip"]');
  if (!tooltip || !target?.isConnected) return;

  activeHeatTooltipTarget = target;
  heatTooltipPinned = options.pinned === true;

  const busyCount = Number(target.dataset.busyCount) || 0;
  const availableCount = Number(target.dataset.availableCount) || 0;
  tooltip.innerHTML = `<p class="heat-tooltip-time">${h(target.dataset.slotRange || "")}</p><p class="heat-tooltip-count">${busyCount}人不空闲 / ${availableCount}人空闲</p><p><strong>不空闲：</strong>${h(target.dataset.busyMembers || "无")}</p><p><strong>空闲：</strong>${h(target.dataset.availableMembers || "无")}</p>`;
  tooltip.hidden = false;
  tooltip.classList.add("visible");
  positionHeatTooltip(target, tooltip);
}

function positionHeatTooltip(target, tooltip) {
  const card = tooltip.closest(".overview-card");
  if (!card) return;

  const cardRect = card.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const inset = 8;
  const maxLeft = Math.max(inset, cardRect.width - tooltipRect.width - inset);
  let left = targetRect.left - cardRect.left + targetRect.width / 2 - tooltipRect.width / 2;
  let top = targetRect.top - cardRect.top - tooltipRect.height - 10;

  left = Math.min(Math.max(left, inset), maxLeft);
  if (top < inset) top = targetRect.bottom - cardRect.top + 8;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideHeatTooltip() {
  const tooltip = view.refs.screen?.querySelector('[data-role="heat-tooltip"]');
  if (tooltip) {
    tooltip.hidden = true;
    tooltip.classList.remove("visible");
    tooltip.removeAttribute("style");
  }
  activeHeatTooltipTarget = null;
  heatTooltipPinned = false;
}

function onInput(event) {
  const field = event.target.dataset.field;
  if (!field) return;

  if (field === "teamCode") {
    const code = sanitizeCode(event.target.value);
    state.teamCode = code;
    event.target.value = code;
    return;
  }

  if (field === "dateDraft") {
    const value = sanitizeDate(event.target.value);
    state.draft.dateDraft = value || state.draft.dateDraft;
    event.target.value = state.draft.dateDraft;
    return;
  }

  if (field === "durationHours") {
    const minutes = hoursInputToMinutes(event.target.value);
    if (minutes) state.draft.durationMinutes = minutes;
    ensureDraftTripTime();
    return;
  }

  if (field === "dayStartTime") {
    const minutes = timeInputToMinutes(event.target.value);
    if (minutes !== null) state.draft.dayStartMinutes = minutes;
    ensureDraftTripTime();
    event.target.value = minutesToTime(state.draft.dayStartMinutes);
    return;
  }

  if (field === "dayEndTime") {
    const minutes = timeInputToMinutes(event.target.value);
    if (minutes !== null) state.draft.dayEndMinutes = minutes;
    ensureDraftTripTime();
    event.target.value = minutesToTime(state.draft.dayEndMinutes);
    return;
  }

  if (field === "teamName") {
    state.draft.teamName = event.target.value;
    return;
  }

  if (field === "userName") {
    state.userName = event.target.value;
  }
}

async function handleLogin() {
  const userName = sanitizeName(state.userName);
  if (!userName) {
    loginMessage = "请输入昵称后再继续。";
    return renderLoginView();
  }

  state.userName = userName;

  if (state.teamMode === "join") {
    const code = sanitizeCode(state.teamCode);
    if (!code || code.length < 4) {
      loginMessage = "请输入至少 4 位行程口令。";
      return renderLoginView();
    }
    state.teamCode = code;
  } else {
    const teamName = sanitizeTeam(state.draft.teamName);
    if (!teamName) {
      loginMessage = "请输入行程名称。";
      return renderLoginView();
    }
    if (state.draft.tripDates.length === 0) {
      loginMessage = "请至少选择一个出行日期。";
      return renderLoginView();
    }
    state.draft.teamName = teamName;
  }

  state.busy = true;
  renderLoginView();

  try {
    const snapshot =
      state.teamMode === "join"
        ? await api("/api/teams/join", {
            method: "POST",
            body: { teamCode: state.teamCode, userName: state.userName },
          })
        : await api("/api/teams", {
            method: "POST",
            body: {
              teamName: state.draft.teamName,
              userName: state.userName,
              tripDates: state.draft.tripDates,
              ...draftTripTimePayload(),
            },
          });

    applySnapshot(snapshot, { replaceDraft: true });
    state.loggedIn = true;
    state.ui.activeScreen = "availability";
    loginMessage = "";
    saveSession();
    startAutoSync();
    renderRoot();
    showNotice(state.teamMode === "join" ? "加入行程成功。" : `行程创建成功，口令 ${state.teamCode}`);
  } catch (error) {
    loginMessage = error.message || "登录失败。";
    renderLoginView();
  } finally {
    state.busy = false;
    if (!state.loggedIn) renderLoginView();
  }
}

async function syncChanges(options = {}) {
  if (!state.loggedIn || !state.memberId || !state.teamCode) return false;

  const silent = options.silent === true;

  if (!hasUnsavedChanges()) {
    return refreshSnapshot({ silent, preserveDraft: true });
  }

  if (!silent) {
    state.busy = true;
    renderLoggedInView();
  }

  try {
    let snapshot = null;
    if (isOrganizer()) {
      snapshot = await api(`/api/teams/${encodeURIComponent(state.teamCode)}?memberId=${state.memberId}`, {
        method: "PATCH",
        body: { teamName: state.draft.teamName, tripDates: state.draft.tripDates, ...draftTripTimePayload() },
      });
    }

    const dirtyDates = changedAvailabilityDates();
    for (const date of dirtyDates) {
      snapshot = await api(`/api/teams/${encodeURIComponent(state.teamCode)}/members/${state.memberId}/availability`, {
        method: "PUT",
        body: { tripDate: date, availability: availabilityForDate(state.draft.availabilityByDate, date) },
      });
    }

    if (!snapshot) {
      return refreshSnapshot({ silent, preserveDraft: true });
    }

    applySnapshot(snapshot, { replaceDraft: true });
    saveSession();
    clearSyncError();

    if (silent) {
      if (!isEditingField()) {
        if (!patchAvailabilityScreen()) {
          renderAppFragments({
            preserveScroll: true,
            chips: true,
            notice: false,
            nav: false,
            header: false,
            screen: true,
          });
        }
      } else {
        refreshSyncIndicators();
      }
    } else {
      renderLoggedInView({ preserveScroll: true });
      showNotice("已同步到数据库。");
    }
    return true;
  } catch (error) {
    if (silent) maybeShowSyncError(error.message || "同步失败。");
    else showNotice(error.message || "同步失败。");
    return false;
  } finally {
    if (!silent) {
      state.busy = false;
      renderLoggedInView({ preserveScroll: true });
    }
  }
}

async function refreshSnapshot(options = {}) {
  if (!state.loggedIn || !state.memberId || !state.teamCode) return false;

  try {
    const snapshot = await api(`/api/teams/${encodeURIComponent(state.teamCode)}?memberId=${state.memberId}`);
    const nextKey = snapshotKey(snapshot);
    const changed = nextKey !== state.server.snapshotKey;

    applySnapshot(snapshot, { replaceDraft: options.preserveDraft !== true });
    clearSyncError();

    if (!options.silent) {
      renderLoggedInView({ preserveScroll: true });
    } else if (changed && !isEditingField()) {
      if (!patchAvailabilityScreen()) {
        renderAppFragments({
          preserveScroll: true,
          chips: true,
          notice: false,
          nav: false,
          header: false,
          screen: true,
        });
      }
    } else if (changed || state.ui.activeScreen === "availability") {
      refreshSyncIndicators();
    }
    return true;
  } catch (error) {
    if (options.silent) {
      if (error.status === 403 || error.status === 404) {
        stopAutoSync();
        clearSession();
        resetForLogin();
        renderRoot();
      } else {
        maybeShowSyncError(error.message || "同步失败。");
      }
      return false;
    }
    throw error;
  }
}

async function autoSyncTick() {
  if (!state.loggedIn || !state.memberId || !state.teamCode) return;
  if (state.busy || state.syncing || document.hidden) return;

  state.syncing = true;
  try {
    if (hasUnsavedChanges()) await syncChanges({ silent: true });
    else await refreshSnapshot({ silent: true, preserveDraft: true });
  } finally {
    state.syncing = false;
  }
}

function startAutoSync() {
  stopAutoSync();
  autosyncTimer = setInterval(() => {
    void autoSyncTick();
  }, AUTOSYNC_INTERVAL_MS);
}

function stopAutoSync() {
  if (!autosyncTimer) return;
  clearInterval(autosyncTimer);
  autosyncTimer = null;
}

function renderRoot() {
  if (state.loading) {
    renderLoadingView();
    return;
  }
  if (!state.loggedIn) {
    renderLoginView();
    return;
  }
  renderLoggedInView();
}

function renderLoadingView() {
  view.mode = "loading";
  view.refs = {};
  appEl.innerHTML = `<div class="login-panel"><section class="login-screen"><div class="login-main"><div class="login-hero"><div class="logo-badge"><img src="./logo-transparent.png" alt="Team Time" class="brand-logo" /></div><h1>正在连接...</h1></div></div></section></div>`;
}

function renderLoginView() {
  ensureDraftTripTime();
  view.mode = "login";
  view.refs = {};
  appEl.innerHTML = `<div class="login-panel"><section class="login-screen">
    <div class="login-main">
      <div class="login-hero"><div class="logo-badge"><img src="./logo-transparent.png" alt="Team Time" class="brand-logo" /></div><div class="hero-chip">Let’s go!</div><h1>出游时光机</h1><p>一次出行就是一个行程。发起人创建行程并设置日期，同行成员只需输入昵称和口令加入。</p></div>
      <section class="login-card">
        <div class="mode-switch"><button class="mode-pill ${state.teamMode === "join" ? "active" : ""}" data-action="set-mode" data-mode="join">加入行程</button><button class="mode-pill ${state.teamMode === "create" ? "active" : ""}" data-action="set-mode" data-mode="create">创建行程</button></div>
        <div class="field-wrap">
          <div class="field"><label>你的昵称</label><div class="field-box"><span class="material-symbols-outlined">person</span><input data-field="userName" value="${a(state.userName)}" placeholder="例如 小林" /></div></div>
          ${
            state.teamMode === "join"
              ? `<div class="field"><label>行程口令</label><div class="field-box"><span class="material-symbols-outlined">key</span><input data-field="teamCode" maxlength="6" value="${a(state.teamCode)}" placeholder="例如 M8K2" /></div></div>`
              : `<div class="field"><label>行程名称</label><div class="field-box"><span class="material-symbols-outlined">groups</span><input data-field="teamName" value="${a(state.draft.teamName)}" placeholder="例如 周末露营" /></div></div><div class="field"><label>行程口令（自动）</label><div class="field-box readonly-box"><span class="material-symbols-outlined">password</span><input readonly value="${a(state.teamCode || "创建后生成")}" /></div></div>`
          }
        </div>
        ${state.teamMode === "create" ? renderDateEditorCard("出行日期", "由发起人统一设置本次行程可选日期。") : ""}
        ${state.teamMode === "create" ? renderTripTimeEditorCard("行程时间", "用于推荐符合预计时长的最佳连续时段。") : ""}
        <div class="login-actions"><button class="primary-btn" data-action="submit-login" ${state.busy ? "disabled" : ""}>${state.busy ? "处理中..." : state.teamMode === "join" ? "加入行程" : "创建行程并开始"}<span class="material-symbols-outlined">arrow_forward</span></button></div>
        ${loginMessage ? `<div class="toast">${h(loginMessage)}</div>` : `<p class="hint">${state.teamMode === "join" ? "加入后会直接看到发起人设定的出行日期，无需自己选择。" : "行程数据会持久保存到 SQLite，重新进入可自动恢复会话。"}</p>`}
      </section>
    </div>
    <footer class="footer-inline"><a href="https://github.com/zhuchenyu2008/team-time" target="_blank" rel="noopener">github.com/zhuchenyu2008/team-time</a><span aria-hidden="true">·</span><span>作者：Zhu Chenyu</span></footer>
  </section></div>`;
}

function renderLoggedInView(options = {}) {
  renderAppFragments({
    preserveScroll: options.preserveScroll === true,
    header: true,
    chips: true,
    notice: true,
    nav: true,
    screen: true,
  });
}

function ensureAppShell() {
  if (view.mode === "app" && view.refs.header) return;

  appEl.innerHTML = `<div class="app-panel">
    <header class="top-bar" data-role="header"></header>
    <main class="screen-body">
      <div class="team-chip-row" data-role="team-chips"></div>
      <div data-role="notice"></div>
      <div data-role="screen"></div>
    </main>
    <nav class="bottom-nav" data-role="nav"></nav>
  </div>`;

  view.mode = "app";
  view.refs = {
    header: appEl.querySelector('[data-role="header"]'),
    screenBody: appEl.querySelector(".screen-body"),
    teamChips: appEl.querySelector('[data-role="team-chips"]'),
    notice: appEl.querySelector('[data-role="notice"]'),
    screen: appEl.querySelector('[data-role="screen"]'),
    nav: appEl.querySelector('[data-role="nav"]'),
  };
}

function renderAppFragments(options = {}) {
  const draw = () => {
    ensureAppShell();
    if (options.header) updateHeader();
    if (options.chips) updateTeamChips();
    if (options.notice) updateNoticeNode();
    if (options.nav) updateNav();
    if (options.screen) updateScreen();
  };

  if (options.preserveScroll) runWithPreservedScroll(draw);
  else draw();
}

function updateHeader() {
  const meta = SCREEN_META[state.ui.activeScreen];
  view.refs.header.innerHTML = `<div class="title-wrap"><span class="material-symbols-outlined title-icon" style="font-variation-settings:'FILL' 1;">${meta.icon}</span><div class="header-meta"><h1 class="title-main">${meta.title}</h1><p class="title-sub">${meta.subtitle}</p></div></div><div class="header-actions">${state.teamCode ? `<button class="icon-btn" data-action="copy-code" aria-label="复制行程口令" title="复制行程口令"><span class="material-symbols-outlined">content_copy</span></button>` : ""}<button class="icon-btn" data-action="logout" aria-label="退出当前行程" title="退出当前行程"><span class="material-symbols-outlined">logout</span></button></div>`;
}

function updateTeamChips() {
  const html = `<span class="team-chip">行程：${h(displayTeamName())}</span>${state.teamCode ? `<span class="team-chip">行程口令：${h(state.teamCode)}</span>` : ""}${state.currentRole ? `<span class="team-chip">身份：${h(state.currentRole)}</span>` : ""}<span class="team-chip">${hasUnsavedChanges() ? "未保存" : "已同步"}</span>`;
  if (view.refs.teamChips.innerHTML !== html) view.refs.teamChips.innerHTML = html;
}

function updateNoticeNode() {
  view.refs.notice.innerHTML = state.ui.notice ? `<div class="toast">${h(state.ui.notice)}</div>` : "";
}

function updateNav() {
  const items = [
    ["availability", "可用", "event_available"],
    ["heatmap", "同行", "grid_view"],
    ["summary", "总结", "insights"],
  ];

  view.refs.nav.innerHTML = items
    .map(
      ([id, label, icon]) =>
        `<button class="nav-item ${state.ui.activeScreen === id ? "active" : ""}" data-action="switch-screen" data-screen="${id}" aria-label="切换到${label}"><span class="material-symbols-outlined" ${state.ui.activeScreen === id ? `style="font-variation-settings:'FILL' 1;"` : ""}>${icon}</span><span>${label}</span></button>`
    )
    .join("");
}

function updateScreen() {
  hideHeatTooltip();
  view.refs.screen.dataset.screen = state.ui.activeScreen;
  view.refs.screen.innerHTML =
    state.ui.activeScreen === "availability"
      ? availabilityTemplate()
      : state.ui.activeScreen === "heatmap"
        ? heatmapTemplate()
        : summaryTemplate();
}

function renderAvailabilityInteraction() {
  if (!state.loggedIn) return;
  if (patchAvailabilityScreen()) return;

  renderAppFragments({
    preserveScroll: true,
    chips: true,
    notice: false,
    nav: false,
    header: false,
    screen: true,
  });
}

function availabilityTemplate() {
  ensureDraftTripTime();
  const { members, countsBySlot, busyCount, indexes } = availabilityMetrics();
  const currentDate = currentActiveDate();

  return `<section>
    <p class="section-label">当前状态</p><h2 class="section-title">我的时间安排</h2>
    <article class="hero-card" data-role="availability-hero"><p class="section-label" style="color:rgba(255,255,255,.82);margin:0;">${dateText(currentDate)} 已标记不空闲时长</p><div class="hero-value"><strong data-role="busy-hours">${hours(busyCount)}</strong><span>小时</span></div><p class="hero-meta" data-role="hero-meta">${dateListText(state.draft.tripDates)} · ${isOrganizer() ? "你可以调整本次行程日期" : "本次行程日期由发起人设置"}</p></article>
    ${renderAvailabilitySettingsCard()}
    ${renderDateSwitch("当前编辑日期")}
    <article class="utility-card"><div class="quick-actions"><button class="quick-btn" data-action="quick-preset" data-preset="all-free">全部空闲</button><button class="quick-btn" data-action="quick-preset" data-preset="all-busy">全部不空闲</button><button class="quick-btn" data-action="quick-preset" data-preset="morning-busy">上午不空闲</button><button class="quick-btn" data-action="quick-preset" data-preset="afternoon-busy">下午不空闲</button></div><button class="filter-btn" data-action="toggle-filter">${state.ui.availabilityFilter === "busy" ? "显示全部时段" : "只看不空闲时段"}</button></article>
    <div class="legend"><span class="legend-item"><i class="legend-dot dot-free"></i>空闲</span><span class="legend-item"><i class="legend-dot dot-mid"></i>多人空闲</span><span class="legend-item"><i class="legend-dot dot-busy"></i>不空闲</span></div>
    ${renderSlotCollection(indexes, countsBySlot, members)}
  </section>`;
}

function renderAvailabilitySettingsCard() {
  if (isOrganizer()) {
    return `${renderDateEditorCard("出行日期", "发起人可调整本次行程的出行日期。")}${renderTripTimeEditorCard("行程时间", "发起人可调整预计时长和每日推荐范围。")}${renderSyncStatusCard()}`;
  }

  const dateSection = renderDateReadonlySection("出行日期", "", "availability-date-section");
  const tripTimeSection = renderTripTimeReadonlySection("行程时间", "", "availability-trip-section");

  return `<article class="utility-card availability-settings-card">${dateSection}${tripTimeSection}${renderSyncStatusSection()}</article>`;
}

function patchAvailabilityScreen() {
  return false;
}

function availabilityMetrics() {
  const members = syncedMembers();
  const countsBySlot = counts(members);
  const availability = activeDraftAvailability();
  const range = visibleSlotRange();
  const visibleIndexes = slotIndexesInRange(range);
  const busyCount = visibleIndexes.filter((index) => !availability[index]).length;
  const indexes =
    state.ui.availabilityFilter === "busy"
      ? visibleIndexes.filter((index) => !availability[index])
      : visibleIndexes;
  return { members, countsBySlot, busyCount, indexes };
}

function updateAvailabilityHero() {
  const busyHours = view.refs.screen.querySelector('[data-role="busy-hours"]');
  const heroMeta = view.refs.screen.querySelector('[data-role="hero-meta"]');
  const availability = activeDraftAvailability();
  const nextHours = hours(slotIndexesInRange(visibleSlotRange()).filter((index) => !availability[index]).length);
  const nextMeta = `${dateListText(state.draft.tripDates)} · ${isOrganizer() ? "你可以调整本次行程日期" : "本次行程日期由发起人设置"}`;
  if (busyHours && busyHours.textContent !== nextHours) busyHours.textContent = nextHours;
  if (heroMeta && heroMeta.textContent !== nextMeta) heroMeta.textContent = nextMeta;
}

function updateAvailabilitySlots() {
  const { members, countsBySlot, indexes } = availabilityMetrics();
  const list = view.refs.screen.querySelector('[data-role="slot-list"]');
  const empty = view.refs.screen.querySelector('[data-role="slot-empty"]');

  if (!list && !empty) return;

  if (!list || state.ui.availabilityFilter === "busy") {
    const current = list || empty;
    if (current) current.outerHTML = renderSlotCollection(indexes, countsBySlot, members);
    return;
  }

  indexes.forEach((index) => {
    const row = list.querySelector(`[data-index="${index}"]`);
    if (row) updateSlotRowNode(row, index, countsBySlot, members);
  });
}

function renderSlotCollection(indexes, countsBySlot, members) {
  if (!indexes.length) return `<div class="empty-tip" data-role="slot-empty">当前没有“不空闲”时段。</div>`;
  return `<div class="slot-list" data-role="slot-list">${indexes.map((index) => renderSlotRow(index, countsBySlot, members)).join("")}</div>`;
}

function renderSlotRow(index, countsBySlot, members) {
  const row = slotRowView(index, countsBySlot, members);
  return `<button class="slot-row ${row.level}" data-action="toggle-slot" data-index="${index}" aria-label="${slotRange(index)} ${row.hint}"><span class="slot-time">${slotRange(index)}</span><span class="slot-content"><span class="slot-title">${row.title}</span><span class="slot-hint">${row.hint}</span></span><span class="material-symbols-outlined">${row.icon}</span></button>`;
}

function updateSlotRowNode(row, index, countsBySlot, members) {
  const next = slotRowView(index, countsBySlot, members);
  const nextClass = `slot-row ${next.level}`;
  const nextIndex = String(index);
  if (row.className !== nextClass) row.className = nextClass;
  if (row.dataset.index !== nextIndex) row.dataset.index = nextIndex;
  const title = row.querySelector(".slot-title");
  const hint = row.querySelector(".slot-hint");
  const icon = row.querySelector(".material-symbols-outlined");
  if (title && title.textContent !== next.title) title.textContent = next.title;
  if (hint && hint.textContent !== next.hint) hint.textContent = next.hint;
  if (icon && icon.textContent !== next.icon) icon.textContent = next.icon;
}

function slotRowView(index, countsBySlot, members) {
  const free = activeDraftAvailability()[index];
  const hot = countsBySlot[index] / Math.max(members.length, 1) >= 0.6;
  const level = free ? "available" : "busy";
  const title = free ? (hot ? "空闲（热门）" : "空闲（默认）") : "不空闲";
  const hint = free ? "点击标记为不空闲" : "点击恢复为空闲";
  const icon = free ? "check_circle" : "do_not_disturb_on";
  return { level, title, hint, icon };
}

function heatmapTemplate() {
  const members = syncedMembers();
  const countsBySlot = counts(members);
  const range = tripTimeSlotRange(syncedTripTime());
  const rangeIndexes = slotIndexesInRange(range);
  const heatGridStyle = `grid-template-columns:repeat(${rangeIndexes.length}, minmax(0, 1fr));`;
  const heatLabels = heatLabelSegments(rangeIndexes, countsBySlot, members.length);
  const heatLabelStrip = heatLabels.length
    ? `<div class="heat-label-strip" style="${heatGridStyle}">${heatLabels.map((segment) => `<span class="heat-busy-label ${segment.chip}" style="grid-column:${segment.columnStart} / span ${segment.span};">${segment.busyCount}人不空闲</span>`).join("")}</div>`
    : "";
  const topSlots = [...rangeIndexes]
    .sort((a, b) => countsBySlot[b] - countsBySlot[a] || a - b)
    .slice(0, 10);
  const currentDate = currentActiveDate();

  return `<section>
    <div class="heatmap-head"><div><p class="section-label">行程概览</p><h2 class="section-title" style="margin-bottom:0;">${members.length} 人时段热力</h2></div><span class="section-label" style="letter-spacing:.04em;">${dateText(currentDate)}</span></div>
    ${renderDateSwitch("当前查看日期")}
    ${
      members.length <= 1
        ? `<article class="empty-state-card"><h3>当前仅有 1 人</h3><p>分享行程口令后即可看到真实的同行时段热力图。</p>${state.teamCode ? `<button class="secondary-btn" data-action="copy-code" aria-label="复制行程口令">复制行程口令</button>` : ""}</article>`
        : ""
    }
    <article class="overview-card">${heatLabelStrip}<div class="heat-strip" style="${heatGridStyle};">${rangeIndexes
      .map((index) => {
        const availableCount = countsBySlot[index];
        const busyCount = Math.max(members.length - availableCount, 0);
        const availableMembers = members.filter((member) => member.availability[index]);
        const busyMembers = members.filter((member) => !member.availability[index]);
        const label = heatCellLabel(index, availableCount, members.length, availableMembers, busyMembers);
        return `<button type="button" class="heat-cell ${heatLevel(availableCount, members.length)}" data-action="show-heat-detail" data-slot-range="${a(slotRange(index))}" data-available-count="${availableCount}" data-busy-count="${busyCount}" data-available-members="${a(memberListText(availableMembers))}" data-busy-members="${a(memberListText(busyMembers))}" aria-label="${a(label)}"></button>`;
      })
      .join("")}</div><div class="heat-axis"><span>${minutesToTime(range.startMinutes)}</span><span>${minutesToTime(range.endMinutes)}</span></div><div class="heat-tooltip" data-role="heat-tooltip" hidden></div></article>
    <p class="section-label" style="margin-top:16px;">推荐范围内 Top 10</p>
    <div class="distribution-list">${topSlots
      .map((index) => {
        const row = members.filter((member) => member.availability[index]);
        const show = row.slice(0, 3);
        const extra = row.length - show.length;
        const level = heatLevel(countsBySlot[index], members.length);
        const chip = chipLevel(level);
        return `<article class="distribution-row ${chip}"><p class="distribution-time">${slotRange(index)}</p><div class="distribution-main"><span class="availability-chip ${chip}">${countsBySlot[index]}/${members.length} 人空闲</span><div class="member-stack">${show.map((member) => `<img src="${avatar(member.id)}" alt="${a(member.name)}" />`).join("")}${extra > 0 ? `<span>+${extra}</span>` : ""}</div></div><span class="material-symbols-outlined">chevron_right</span></article>`;
      })
      .join("")}</div>
  </section>`;
}

function summaryTemplate() {
  const ranked = rankedDateWindows();
  const bestResult = ranked.find((item) => item.best.hasAvailability);
  const activeResult = ranked.find((item) => item.date === currentActiveDate()) || ranked[0];
  const tripTime = syncedTripTime();

  if (!bestResult) {
    return `<section><article class="empty-state-card"><h3>还没有可推荐时段</h3><p>请先在“可用时间”页面标记不空闲时段并等待自动同步完成。</p><button class="primary-btn" data-action="go-edit"><span class="material-symbols-outlined">edit_calendar</span>去调整时段</button></article></section>`;
  }

  const { date, members, best } = bestResult;
  const duration = best.end - best.start;
  const full = members.filter((member) => countRange(member.availability, best.start, best.end) === duration).length;
  const activeBestText =
    activeResult && activeResult.best.hasAvailability
      ? `${dateText(activeResult.date)} · ${slotStart(activeResult.best.start)} - ${slotEnd(activeResult.best.end)}`
      : `${dateText(currentActiveDate())} · 暂无可推荐时段`;

  return `<section>
    <article class="summary-banner"><div class="summary-figure"></div><p class="section-label" style="margin-bottom:6px;">排期结果</p><h2 class="section-title" style="margin-bottom:4px;">最佳候选已生成</h2><p style="margin:0;color:var(--on-surface-variant);font-size:.88rem;font-weight:600;">推荐日期：${dateText(date)}</p></article>
    <article class="best-window"><span class="best-tag"><span class="material-symbols-outlined" style="font-size:15px;font-variation-settings:'FILL' 1;">auto_awesome</span>推荐时段</span><h3>${slotStart(best.start)} - ${slotEnd(best.end)}</h3><p>${dateText(date)} · 连续 ${duration * SLOT_STEP} 分钟</p><p>${full}/${members.length} 位成员可全程参加</p></article>
    ${renderDateSwitch("查看候选日期")}
    <article class="utility-card"><p class="section-label">当前日期候选</p><p class="date-helper">${activeBestText}<br />${formatDuration(tripTime.durationMinutes)} · ${minutesToTime(tripTime.dayStartMinutes)}-${minutesToTime(tripTime.dayEndMinutes)}</p></article>
    <p class="section-label" style="margin-top:18px;">参与成员</p>
    <div class="attendee-grid">${members
      .map((member) => {
        const availableSlots = countRange(member.availability, best.start, best.end);
        const status =
          availableSlots === duration
            ? ["status-full", "全程可参加"]
            : availableSlots > 0
              ? ["status-partial", `可参加 ${availableSlots * SLOT_STEP} 分钟`]
              : ["status-none", "不可参加"];
        return `<article class="attendee-card"><img class="avatar" src="${avatar(member.id)}" alt="${a(member.name)}" /><div class="attendee-main"><p class="attendee-name">${h(member.name)}</p><p class="attendee-meta">${h(member.role)}</p></div><span class="status-pill ${status[0]}">${status[1]}</span></article>`;
      })
      .join("")}</div>
    <div class="action-stack"><button class="primary-btn" data-action="download-ics"><span class="material-symbols-outlined">calendar_add_on</span>添加到日历</button><button class="secondary-btn" data-action="go-edit">返回调整时段</button></div>
  </section>`;
}

function renderSyncStatusCard() {
  return `<article class="utility-card" data-role="sync-status-card"><p class="section-label">同步状态</p><p class="date-helper"><span data-role="sync-message">${h(syncStatusMessage())}</span><br /><span data-role="sync-time">${h(syncStatusTimeText())}</span></p></article>`;
}

function renderSyncStatusSection() {
  return `<div class="availability-sync-footer" data-role="sync-status-card"><span class="section-label availability-sync-label">同步状态</span><span class="availability-sync-copy"><span data-role="sync-message">${h(syncStatusMessage())}</span><span class="availability-sync-sep">·</span><span data-role="sync-time">${h(syncStatusTimeText())}</span></span></div>`;
}

function refreshSyncIndicators() {
  if (!state.loggedIn || view.mode !== "app") return;

  updateTeamChips();

  if (state.ui.activeScreen !== "availability" || !view.refs.screen) return;

  const card = view.refs.screen.querySelector('[data-role="sync-status-card"]');
  const message = card?.querySelector('[data-role="sync-message"]');
  const time = card?.querySelector('[data-role="sync-time"]');
  if (!card || !message || !time) return;
  const nextMessage = syncStatusMessage();
  const nextTime = syncStatusTimeText();
  if (message.textContent !== nextMessage) message.textContent = nextMessage;
  if (time.textContent !== nextTime) time.textContent = nextTime;
}

function syncStatusMessage() {
  return hasUnsavedChanges() ? "状态：待同步" : "状态：已同步";
}

function syncStatusTimeText() {
  return state.server.lastSyncedAt ? `最近同步：${timeText(state.server.lastSyncedAt)}` : "最近同步：等待中";
}

function renderDateSwitch(title) {
  const dates = activeTripDates();
  if (dates.length <= 1) {
    return `<article class="utility-card"><p class="section-label">${title}</p><p class="date-helper">${dateText(dates[0] || DEFAULT_TRIP_DATE)}</p></article>`;
  }
  const active = currentActiveDate();
  return `<article class="utility-card"><p class="section-label">${title}</p><div class="date-switch-list">${dates
    .map(
      (date) =>
        `<button class="date-switch-btn ${date === active ? "active" : ""}" data-action="set-active-date" data-date="${date}" aria-label="切换到 ${dateText(date)}">${dateText(date)}</button>`
    )
    .join("")}</div></article>`;
}

function renderDateEditorCard(title, hint) {
  return `<article class="utility-card">${renderDateEditorSection(title, hint)}</article>`;
}

function renderDateEditorSection(title, hint, extraClass = "") {
  const inner = `<p class="section-label">${title}</p><p class="date-helper">${hint}</p><div class="date-row"><span class="material-symbols-outlined">event</span><input class="date-input" data-field="dateDraft" type="date" value="${a(state.draft.dateDraft)}" aria-label="选择出行日期" /><button class="date-add-btn" data-action="add-date" aria-label="添加出行日期">添加</button></div><div class="date-chip-list">${state.draft.tripDates.map((date) => `<span class="date-chip ${date === currentActiveDate() ? "active" : ""}">${dateText(date)}<button class="date-remove-btn" data-action="remove-date" data-date="${date}" aria-label="移除 ${dateText(date)}" ${state.draft.tripDates.length <= 1 ? "disabled" : ""}><span class="material-symbols-outlined">close</span></button></span>`).join("")}</div>`;
  return extraClass ? `<div class="availability-settings-section ${extraClass}">${inner}</div>` : inner;
}

function renderDateReadonlyCard(title, hint) {
  return `<article class="utility-card">${renderDateReadonlySection(title, hint)}</article>`;
}

function renderDateReadonlySection(title, hint, extraClass = "") {
  const hintHtml = hint ? `<p class="date-helper">${hint}</p>` : "";
  const inner = `<p class="section-label">${title}</p>${hintHtml}<div class="date-chip-list">${syncedTripDates().map((date) => `<span class="date-chip ${date === currentActiveDate() ? "active" : ""}">${dateText(date)}</span>`).join("")}</div>`;
  return extraClass ? `<div class="availability-settings-section ${extraClass}">${inner}</div>` : inner;
}

function renderTripTimeEditorCard(title, hint) {
  return `<article class="utility-card">${renderTripTimeEditorSection(title, hint)}</article>`;
}

function renderTripTimeEditorSection(title, hint, extraClass = "") {
  ensureDraftTripTime();
  const duration = state.draft.durationMinutes;
  const durationHours = duration / 60;
  const presets = [60, 120, 180, 240];
  const inner = `<p class="section-label">${title}</p><p class="date-helper">${hint}</p><div class="duration-preset-list">${presets
    .map(
      (minutes) =>
        `<button class="duration-preset-btn ${minutes === duration ? "active" : ""}" data-action="set-duration" data-minutes="${minutes}" aria-label="设置预计时长为 ${formatDuration(minutes)}">${formatDuration(minutes)}</button>`
    )
    .join("")}</div><div class="trip-time-grid"><label class="time-field"><span>预计时长</span><input data-field="durationHours" type="number" min="0.5" max="24" step="0.5" value="${a(formatHoursInput(durationHours))}" /><small>小时</small></label><label class="time-field"><span>开始时间</span><select data-field="dayStartTime">${timeOptions(START_MIN, END_MIN - SLOT_STEP, state.draft.dayStartMinutes)}</select></label><label class="time-field"><span>结束时间</span><select data-field="dayEndTime">${timeOptions(START_MIN + SLOT_STEP, END_MIN, state.draft.dayEndMinutes)}</select></label></div><p class="time-summary">${h(tripTimeSummary(state.draft))}</p>`;
  return extraClass ? `<div class="availability-settings-section ${extraClass}">${inner}</div>` : inner;
}

function renderTripTimeReadonlyCard(title, hint) {
  return `<article class="utility-card">${renderTripTimeReadonlySection(title, hint)}</article>`;
}

function renderTripTimeReadonlySection(title, hint, extraClass = "") {
  const tripTime = syncedTripTime();
  const hintHtml = hint ? `<p class="date-helper">${hint}</p>` : "";
  const inner = `<p class="section-label">${title}</p>${hintHtml}<div class="date-chip-list"><span class="date-chip">${formatDuration(tripTime.durationMinutes)}</span><span class="date-chip">${minutesToTime(tripTime.dayStartMinutes)}-${minutesToTime(tripTime.dayEndMinutes)}</span></div>`;
  return extraClass ? `<div class="availability-settings-section ${extraClass}">${inner}</div>` : inner;
}

function addDate() {
  const inputDate = sanitizeDate(appEl.querySelector('[data-field="dateDraft"]')?.value);
  const date = inputDate || sanitizeDate(state.draft.dateDraft);
  if (!date) return showNotice("请选择有效日期。");
  if (state.draft.tripDates.includes(date)) return showNotice("该日期已存在。");
  state.draft.tripDates = [...state.draft.tripDates, date].sort();
  state.draft.dateDraft = date;
  state.ui.activeDate = date;
  ensureDraftAvailabilityDates();
  if (state.loggedIn) renderLoggedInView({ preserveScroll: true });
  else renderLoginView();
}

function removeDate(dateText) {
  if (state.draft.tripDates.length <= 1) return showNotice("至少保留一个计划日期。");
  state.draft.tripDates = state.draft.tripDates.filter((date) => date !== dateText);
  if (state.draft.dateDraft === dateText || !sanitizeDate(state.draft.dateDraft)) state.draft.dateDraft = state.draft.tripDates[0];
  delete state.draft.availabilityByDate[dateText];
  ensureActiveDate();
  ensureDraftAvailabilityDates();
  if (state.loggedIn) renderLoggedInView({ preserveScroll: true });
  else renderLoginView();
}

function applyPreset(preset) {
  const values = [...activeDraftAvailability()];
  const range = visibleSlotRange();
  const visibleIndexes = slotIndexesInRange(range);
  if (preset === "all-free") {
    visibleIndexes.forEach((index) => {
      values[index] = true;
    });
    state.draft.availabilityByDate[currentActiveDate()] = values;
  }
  if (preset === "all-busy") {
    visibleIndexes.forEach((index) => {
      values[index] = false;
    });
    state.draft.availabilityByDate[currentActiveDate()] = values;
  }
  if (preset === "morning-busy") {
    for (let index = Math.max(range.startIndex, 16); index < Math.min(range.endIndex, 24); index += 1) values[index] = false;
    state.draft.availabilityByDate[currentActiveDate()] = values;
  }
  if (preset === "afternoon-busy") {
    for (let index = Math.max(range.startIndex, 26); index < Math.min(range.endIndex, 36); index += 1) values[index] = false;
    state.draft.availabilityByDate[currentActiveDate()] = values;
  }
}

function applySnapshot(snapshot, options = {}) {
  if (!snapshot?.team) return;

  const replaceDraft = options.replaceDraft === true;
  const hadDirtyAvailability = availabilityChanged();
  const hadDirtyTeam = teamChanged();

  const tripDates = normalizeTripDates(snapshot.team.tripDates || snapshot.team.tripDate);
  const normalizedTripDates = tripDates.length ? tripDates : [DEFAULT_TRIP_DATE];
  const tripTime = normalizeTripTime(snapshot.team);
  const members = normalizeMembers(snapshot.members, normalizedTripDates);
  const currentMember = snapshot.currentMember || null;
  const memberId = currentMember ? Number(currentMember.id) : state.memberId;
  const myMember = members.find((member) => member.id === memberId);
  const myAvailabilityByDate = myMember ? cloneAvailabilityMap(myMember.availabilityByDate, normalizedTripDates) : availabilityMap(normalizedTripDates);

  state.teamCode = snapshot.team.code || state.teamCode;
  state.server.teamName = String(snapshot.team.name || "");
  state.server.tripDates = normalizedTripDates;
  state.server.durationMinutes = tripTime.durationMinutes;
  state.server.dayStartMinutes = tripTime.dayStartMinutes;
  state.server.dayEndMinutes = tripTime.dayEndMinutes;
  state.server.members = members;
  state.server.myAvailabilityByDate = myAvailabilityByDate;
  state.server.lastSyncedAt = new Date().toISOString();
  state.server.snapshotKey = snapshotKey({
    team: {
      code: state.teamCode,
      name: state.server.teamName,
      tripDates: state.server.tripDates,
      durationMinutes: state.server.durationMinutes,
      dayStartMinutes: state.server.dayStartMinutes,
      dayEndMinutes: state.server.dayEndMinutes,
    },
    currentMember: currentMember ? { id: memberId } : null,
    members: state.server.members,
  });

  if (currentMember) {
    state.memberId = memberId;
    state.userName = String(currentMember.name || state.userName);
    state.currentRole = String(currentMember.role || "");
  }

  if (replaceDraft || !hadDirtyTeam) {
    state.draft.teamName = state.server.teamName;
    state.draft.tripDates = [...state.server.tripDates];
    state.draft.durationMinutes = state.server.durationMinutes;
    state.draft.dayStartMinutes = state.server.dayStartMinutes;
    state.draft.dayEndMinutes = state.server.dayEndMinutes;
  }
  if (!state.draft.tripDates.length) state.draft.tripDates = [DEFAULT_TRIP_DATE];
  if (!sanitizeDate(state.draft.dateDraft)) state.draft.dateDraft = state.draft.tripDates[0];
  ensureActiveDate();

  if (replaceDraft || !hadDirtyAvailability) {
    state.draft.availabilityByDate = cloneAvailabilityMap(state.server.myAvailabilityByDate, state.draft.tripDates);
  }
  ensureDraftTripTime();
  ensureDraftAvailabilityDates();
}

function normalizeMembers(input, tripDates = activeTripDates()) {
  if (!Array.isArray(input)) return [];
  const dates = normalizeTripDates(tripDates);
  const active = dates.includes(state.ui.activeDate) ? state.ui.activeDate : dates[0] || DEFAULT_TRIP_DATE;
  return input.map((member) => ({
    id: Number(member.id) || 0,
    name: String(member.name || ""),
    role: String(member.role || "成员"),
    availability: availabilityForDate(normalizeAvailabilityByDate(member.availabilityByDate, dates, member.availability), active),
    availabilityByDate: normalizeAvailabilityByDate(member.availabilityByDate, dates, member.availability),
  }));
}

function syncedMembers() {
  if (state.server.members.length) return membersForDate(currentActiveDate());
  return [
    {
      id: state.memberId || 0,
      name: state.userName || "你",
      role: state.currentRole || "你",
      availability: availabilityForDate(state.server.myAvailabilityByDate, currentActiveDate()),
      availabilityByDate: cloneAvailabilityMap(state.server.myAvailabilityByDate, activeTripDates()),
    },
  ];
}

function syncedTripDates() {
  return state.server.tripDates.length ? state.server.tripDates : state.draft.tripDates;
}

function syncedTripTime() {
  return normalizeTripTime(state.server);
}

function activeTripDates() {
  return state.draft.tripDates.length ? state.draft.tripDates : syncedTripDates();
}

function currentActiveDate() {
  ensureActiveDate();
  return state.ui.activeDate;
}

function ensureActiveDate() {
  const dates = activeTripDates();
  if (!dates.includes(state.ui.activeDate)) state.ui.activeDate = dates[0] || DEFAULT_TRIP_DATE;
  if (!sanitizeDate(state.draft.dateDraft)) state.draft.dateDraft = state.ui.activeDate;
}

function activeDraftAvailability() {
  ensureDraftAvailabilityDates();
  return state.draft.availabilityByDate[currentActiveDate()];
}

function ensureDraftAvailabilityDates() {
  state.draft.tripDates = normalizeTripDates(state.draft.tripDates);
  if (!state.draft.tripDates.length) state.draft.tripDates = [DEFAULT_TRIP_DATE];
  state.draft.availabilityByDate = cloneAvailabilityMap(state.draft.availabilityByDate, state.draft.tripDates);
  ensureActiveDate();
}

function ensureDraftTripTime() {
  const normalized = normalizeTripTime(state.draft);
  state.draft.durationMinutes = normalized.durationMinutes;
  state.draft.dayStartMinutes = normalized.dayStartMinutes;
  state.draft.dayEndMinutes = normalized.dayEndMinutes;
}

function membersForDate(date) {
  return state.server.members.map((member) => ({
    ...member,
    availability: availabilityForDate(member.availabilityByDate, date),
  }));
}

function displayTeamName() {
  return state.draft.teamName || state.server.teamName || "未命名行程";
}

function availabilityChanged() {
  return changedAvailabilityDates().length > 0;
}

function teamChanged() {
  return (
    isOrganizer() &&
    (state.draft.teamName !== state.server.teamName ||
      !sameStringArray(state.draft.tripDates, state.server.tripDates) ||
      state.draft.durationMinutes !== state.server.durationMinutes ||
      state.draft.dayStartMinutes !== state.server.dayStartMinutes ||
      state.draft.dayEndMinutes !== state.server.dayEndMinutes)
  );
}

function hasUnsavedChanges() {
  return availabilityChanged() || teamChanged();
}

function resetForLogin() {
  state.loading = false;
  state.busy = false;
  state.syncing = false;
  state.loggedIn = false;
  state.teamMode = "join";
  state.teamCode = "";
  state.userName = "";
  state.memberId = null;
  state.currentRole = "";
  state.ui.activeScreen = "availability";
  state.ui.availabilityFilter = "all";
  state.ui.activeDate = DEFAULT_TRIP_DATE;
  state.ui.notice = "";
  state.draft.teamName = "";
  state.draft.tripDates = [DEFAULT_TRIP_DATE];
  state.draft.dateDraft = DEFAULT_TRIP_DATE;
  state.draft.durationMinutes = DEFAULT_TRIP_TIME.durationMinutes;
  state.draft.dayStartMinutes = DEFAULT_TRIP_TIME.dayStartMinutes;
  state.draft.dayEndMinutes = DEFAULT_TRIP_TIME.dayEndMinutes;
  state.draft.availabilityByDate = availabilityMap([DEFAULT_TRIP_DATE]);
  state.server.teamName = "";
  state.server.tripDates = [DEFAULT_TRIP_DATE];
  state.server.durationMinutes = DEFAULT_TRIP_TIME.durationMinutes;
  state.server.dayStartMinutes = DEFAULT_TRIP_TIME.dayStartMinutes;
  state.server.dayEndMinutes = DEFAULT_TRIP_TIME.dayEndMinutes;
  state.server.members = [];
  state.server.myAvailabilityByDate = availabilityMap([DEFAULT_TRIP_DATE]);
  state.server.lastSyncedAt = "";
  state.server.snapshotKey = "";
  loginMessage = "";
  clearSyncError();
}

async function api(path, options = {}) {
  const config = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, config);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败(${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function downloadIcs() {
  const result = rankedDateWindows().find((item) => item.best.hasAvailability);
  if (!result) return showNotice("当前没有可导出的推荐时段。");

  const { date, best } = result;
  const start = slotDate(date, best.start);
  const end = slotDate(date, best.end);
  const event = [
    "BEGIN:VEVENT",
    `UID:${Date.now()}-${date}@teamtime.local`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`${state.server.teamName || "行程"} 出游活动`)}`,
    `DESCRIPTION:${icsText(`自动推荐日期：${dateText(date)}；时段：${slotStart(best.start)} - ${slotEnd(best.end)}`)}`,
    "END:VEVENT",
  ].join("\r\n");

  const text = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Team Time//Trip Planner//CN", event, "END:VCALENDAR", ""].join("\r\n");
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "team-time-event.ics";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showNotice("已生成日历文件。");
}

async function copyCode() {
  if (!state.teamCode) return showNotice("当前没有可复制口令。");

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(state.teamCode);
    } else {
      const input = document.createElement("input");
      input.value = state.teamCode;
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    showNotice("行程口令已复制。");
  } catch {
    showNotice("复制失败，请手动记录。");
  }
}

function showNotice(text) {
  state.ui.notice = String(text || "");
  if (state.loggedIn && view.mode === "app") updateNoticeNode();
  else renderRoot();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    state.ui.notice = "";
    if (state.loggedIn && view.mode === "app") updateNoticeNode();
    else renderRoot();
  }, 2200);
}

function maybeShowSyncError(text) {
  const message = String(text || "同步失败。");
  const now = Date.now();
  if (message === lastSyncErrorText && now - lastSyncErrorAt < 5000) return;
  lastSyncErrorText = message;
  lastSyncErrorAt = now;
  showNotice(message);
}

function clearSyncError() {
  lastSyncErrorText = "";
  lastSyncErrorAt = 0;
}

function saveSession() {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      teamCode: state.teamCode,
      memberId: state.memberId,
      userName: state.userName,
    })
  );
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      teamCode: sanitizeCode(parsed.teamCode),
      memberId: Number(parsed.memberId) || null,
      userName: sanitizeName(parsed.userName),
    };
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function isOrganizer() {
  return state.currentRole === "发起人";
}

function counts(members) {
  return SLOT_LABELS.map((_, index) => members.reduce((sum, member) => sum + (member.availability[index] ? 1 : 0), 0));
}

function bestWindow(countsBySlot, total, tripTime = syncedTripTime()) {
  const range = tripTimeSlotRange(tripTime);
  const length = Math.max(1, Math.round(tripTime.durationMinutes / SLOT_STEP));
  if (range.endIndex - range.startIndex < length) {
    return { start: range.startIndex, end: range.startIndex, score: -Infinity, hasAvailability: false };
  }
  const rangeCounts = countsBySlot.slice(range.startIndex, range.endIndex);
  if (rangeCounts.every((count) => count === 0)) {
    return { start: range.startIndex, end: range.startIndex + length, score: -Infinity, hasAvailability: false };
  }

  let best = { start: range.startIndex, end: range.startIndex + length, score: -Infinity, hasAvailability: true };
  for (let start = range.startIndex; start + length <= range.endIndex; start += 1) {
    const segment = countsBySlot.slice(start, start + length);
    const min = Math.min(...segment);
    const avg = segment.reduce((sum, count) => sum + count, 0) / length;
    let score = min * 18 + avg * 5;
    if (min === 0) score -= 100;
    if (min === total) score += 25;
    if (score > best.score) best = { start, end: start + length, score, hasAvailability: true };
  }
  return best;
}

function countRange(values, start, end) {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    if (values[index]) total += 1;
  }
  return total;
}

function heatLabelSegments(indexes, countsBySlot, total) {
  const segments = [];
  let current = null;

  indexes.forEach((slotIndex, columnIndex) => {
    const busyCount = Math.max(total - (countsBySlot[slotIndex] || 0), 0);
    if (busyCount <= 0) {
      if (current) segments.push(current);
      current = null;
      return;
    }

    if (current && current.busyCount === busyCount) {
      current.span += 1;
      return;
    }

    if (current) segments.push(current);
    current = {
      busyCount,
      columnStart: columnIndex + 1,
      span: 1,
      chip: chipLevel(heatLevel(total - busyCount, total)),
    };
  });

  if (current) segments.push(current);
  return segments.filter((segment) => segment.span >= MIN_HEAT_LABEL_SPAN);
}

function heatCellLabel(index, availableCount, total, availableMembers = [], busyMembers = []) {
  if (total <= 0) return `${slotRange(index)}：暂无成员`;
  const busyCount = Math.max(total - availableCount, 0);
  return `${slotRange(index)}：${busyCount}人不空闲 / ${availableCount}人空闲，不空闲：${memberListText(busyMembers)}，空闲：${memberListText(availableMembers)}`;
}

function memberListText(members) {
  if (!Array.isArray(members) || !members.length) return "无";
  const names = members.map((member) => String(member.name || "成员"));
  const visible = names.slice(0, 4).join("、");
  const extra = names.length - 4;
  return extra > 0 ? `${visible}、+${extra}` : visible;
}

function heatLevel(count, total) {
  if (count <= 0) return "heat-none";
  if (total <= 0) return "heat-none";
  if (count >= total) return "heat-full";
  const ratio = count / total;
  if (ratio >= 0.75) return "heat-most";
  if (ratio >= 0.5) return "heat-half";
  return "heat-some";
}

function chipLevel(level) {
  return (
    {
      "heat-full": "full",
      "heat-most": "most",
      "heat-half": "half",
      "heat-some": "some",
      "heat-none": "none",
    }[level] || "none"
  );
}

function normalizeAvailability(input) {
  if (!Array.isArray(input)) return Array(SLOT_COUNT).fill(true);
  const values = Array(SLOT_COUNT).fill(true);
  for (let index = 0; index < SLOT_COUNT; index += 1) values[index] = Boolean(input[index]);
  return values;
}

function availabilityMap(dates, fallback) {
  const map = {};
  normalizeTripDates(dates).forEach((date) => {
    map[date] = fallback ? normalizeAvailability(fallback) : Array(SLOT_COUNT).fill(true);
  });
  return map;
}

function normalizeAvailabilityByDate(input, dates, fallbackAvailability) {
  const map = {};
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fallback = normalizeAvailability(fallbackAvailability);
  normalizeTripDates(dates).forEach((date) => {
    map[date] = normalizeAvailability(source[date] || fallback);
  });
  return map;
}

function cloneAvailabilityMap(input, dates) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const map = {};
  normalizeTripDates(dates).forEach((date) => {
    map[date] = normalizeAvailability(source[date]);
  });
  return map;
}

function availabilityForDate(map, date) {
  return normalizeAvailability(map?.[date]);
}

function changedAvailabilityDates() {
  return state.draft.tripDates.filter(
    (date) => !sameBooleanArray(availabilityForDate(state.draft.availabilityByDate, date), availabilityForDate(state.server.myAvailabilityByDate, date))
  );
}

function draftTripTimePayload() {
  ensureDraftTripTime();
  return {
    durationMinutes: state.draft.durationMinutes,
    dayStartMinutes: state.draft.dayStartMinutes,
    dayEndMinutes: state.draft.dayEndMinutes,
  };
}

function visibleSlotRange() {
  return tripTimeSlotRange(isOrganizer() ? state.draft : syncedTripTime());
}

function tripTimeSlotRange(tripTime) {
  const normalized = normalizeTripTime(tripTime);
  return {
    startMinutes: normalized.dayStartMinutes,
    endMinutes: normalized.dayEndMinutes,
    startIndex: Math.max(0, Math.round((normalized.dayStartMinutes - START_MIN) / SLOT_STEP)),
    endIndex: Math.min(SLOT_COUNT, Math.round((normalized.dayEndMinutes - START_MIN) / SLOT_STEP)),
  };
}

function slotIndexesInRange(range) {
  const indexes = [];
  for (let index = range.startIndex; index < range.endIndex; index += 1) indexes.push(index);
  return indexes;
}

function normalizeTripTime(input) {
  const durationMinutes = clampSlotMinutes(input?.durationMinutes, DEFAULT_TRIP_TIME.durationMinutes, SLOT_STEP, END_MIN - START_MIN);
  let dayStartMinutes = clampSlotMinutes(input?.dayStartMinutes, DEFAULT_TRIP_TIME.dayStartMinutes, START_MIN, END_MIN - SLOT_STEP);
  let dayEndMinutes = clampSlotMinutes(input?.dayEndMinutes, DEFAULT_TRIP_TIME.dayEndMinutes, START_MIN + SLOT_STEP, END_MIN);
  if (dayStartMinutes >= dayEndMinutes) {
    dayStartMinutes = START_MIN;
    dayEndMinutes = END_MIN;
  }
  if (dayEndMinutes - dayStartMinutes < durationMinutes) {
    dayEndMinutes = Math.min(END_MIN, dayStartMinutes + durationMinutes);
    if (dayEndMinutes - dayStartMinutes < durationMinutes) dayStartMinutes = Math.max(START_MIN, dayEndMinutes - durationMinutes);
  }
  return { durationMinutes, dayStartMinutes, dayEndMinutes };
}

function clampSlotMinutes(value, fallback, min, max) {
  const number = Number(value);
  const source = Number.isFinite(number) ? number : fallback;
  const stepped = Math.round(source / SLOT_STEP) * SLOT_STEP;
  return Math.min(max, Math.max(min, stepped));
}

function rankedDateWindows() {
  const tripTime = syncedTripTime();
  return syncedTripDates()
    .map((date) => {
      const members = membersForDate(date);
      const best = bestWindow(counts(members), members.length, tripTime);
      return { date, members, best };
    })
    .sort((a, b) => {
      if (b.best.hasAvailability !== a.best.hasAvailability) return Number(b.best.hasAvailability) - Number(a.best.hasAvailability);
      return (b.best.score ?? -Infinity) - (a.best.score ?? -Infinity);
    });
}

function normalizeTripDates(input) {
  const source = Array.isArray(input) ? input : [input];
  const set = new Set();
  source.forEach((item) => {
    const date = sanitizeDate(item);
    if (date) set.add(date);
  });
  return [...set].sort();
}

function sanitizeDate(text) {
  const value = String(text || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function sanitizeName(text) {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function sanitizeTeam(text) {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 30);
}

function sanitizeCode(text) {
  return String(text || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
}

function sameBooleanArray(a1, a2) {
  if (!Array.isArray(a1) || !Array.isArray(a2) || a1.length !== a2.length) return false;
  for (let index = 0; index < a1.length; index += 1) {
    if (Boolean(a1[index]) !== Boolean(a2[index])) return false;
  }
  return true;
}

function sameStringArray(a1, a2) {
  if (!Array.isArray(a1) || !Array.isArray(a2) || a1.length !== a2.length) return false;
  for (let index = 0; index < a1.length; index += 1) {
    if (String(a1[index]) !== String(a2[index])) return false;
  }
  return true;
}

function snapshotKey(snapshot) {
  const team = snapshot?.team || {};
  const tripDates = normalizeTripDates(team.tripDates || team.tripDate);
  const members = normalizeMembers(snapshot?.members || [], tripDates);
  const tripTime = normalizeTripTime(team);
  return JSON.stringify({
    teamCode: String(team.code || ""),
    teamName: String(team.name || ""),
    tripDates,
    durationMinutes: tripTime.durationMinutes,
    dayStartMinutes: tripTime.dayStartMinutes,
    dayEndMinutes: tripTime.dayEndMinutes,
    currentMemberId: Number(snapshot?.currentMember?.id) || 0,
    members: members.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      availabilityByDate: member.availabilityByDate,
    })),
  });
}

function runWithPreservedScroll(work) {
  const scrollingEl = view.refs.screenBody || document.scrollingElement || document.documentElement;
  const restoreScroll = () => {
    if (scrollingEl) scrollingEl.scrollTop = top;
    else window.scrollTo(0, top);
  };
  const top = scrollingEl ? scrollingEl.scrollTop : window.scrollY;
  work();
  restoreScroll();
  requestAnimationFrame(restoreScroll);
}

function isEditingField() {
  const element = document.activeElement;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
}

function makeTeamCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let index = 0; index < 4; index += 1) value += chars[Math.floor(Math.random() * chars.length)];
  return value;
}

function slotStart(index) {
  const total = START_MIN + index * SLOT_STEP;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function slotEnd(index) {
  return slotStart(index);
}

function slotRange(index) {
  return `${slotStart(index)}-${slotEnd(index + 1)}`;
}

function slotLabel(index) {
  return slotRange(index);
}

function slotDate(dateIso, index) {
  const [year, month, day] = dateIso.split("-").map(Number);
  const date = new Date(year, month - 1, day, 8, 0, 0, 0);
  date.setMinutes(date.getMinutes() + index * SLOT_STEP);
  return date;
}

function timeInputToMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 24 || minutes > 59) return null;
  if (hours === 24 && minutes !== 0) return null;
  return hours * 60 + minutes;
}

function hoursInputToMinutes(value) {
  const hoursValue = Number(value);
  if (!Number.isFinite(hoursValue) || hoursValue <= 0) return null;
  return Math.round((hoursValue * 60) / SLOT_STEP) * SLOT_STEP;
}

function icsDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function dateText(iso) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(`${iso}T12:00:00`));
}

function dateListText(dates) {
  const text = dates.map((date) => dateText(date));
  if (text.length <= 3) return text.join("、");
  return `${text.slice(0, 3).join("、")} 等 ${text.length} 天`;
}

function timeText(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function hours(slotCount) {
  const value = slotCount / 2;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatHoursInput(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDuration(minutes) {
  const value = minutes / 60;
  return `${formatHoursInput(value)} 小时`;
}

function tripTimeSummary(tripTime) {
  const normalized = normalizeTripTime(tripTime);
  return `推荐 ${formatDuration(normalized.durationMinutes)} 连续时段，范围 ${minutesToTime(normalized.dayStartMinutes)}-${minutesToTime(normalized.dayEndMinutes)}`;
}

function minutesToTime(minutes) {
  const normalized = Math.max(0, Math.min(24 * 60, Number(minutes) || 0));
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function timeOptions(min, max, selected) {
  const options = [];
  for (let minutes = min; minutes <= max; minutes += SLOT_STEP) {
    options.push(`<option value="${minutesToTime(minutes)}" ${minutes === selected ? "selected" : ""}>${minutesToTime(minutes)}</option>`);
  }
  return options.join("");
}

function avatar(seed) {
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed || "member")}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
}

function nextSaturday() {
  const date = new Date();
  let add = (6 - date.getDay() + 7) % 7;
  if (add === 0) add = 7;
  date.setDate(date.getDate() + add);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function h(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function a(text) {
  return h(text).replaceAll("`", "&#96;");
}

function icsText(text) {
  return String(text).replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\n", "\\n");
}
