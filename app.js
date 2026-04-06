const SESSION_KEY = "team-time-session-v1";
const SLOT_COUNT = 28;
const SLOT_STEP = 30;
const START_MIN = 8 * 60;

const SCREEN_META = {
  availability: { icon: "event_available", title: "可用时间", subtitle: "标记你能参加的时段" },
  heatmap: { icon: "grid_view", title: "团队热力图", subtitle: "查看重叠情况并管理成员" },
  summary: { icon: "insights", title: "总结推荐", subtitle: "自动计算最佳连续窗口" },
};
const SLOT_LABELS = Array.from({ length: SLOT_COUNT }, (_, i) => slotLabel(i));
const PATTERNS = [
  { id: "morning", label: "上午", range: [0, 8] },
  { id: "afternoon", label: "下午", range: [8, 20] },
  { id: "evening", label: "晚上", range: [20, 28] },
  { id: "all", label: "全天", range: [0, 28] },
];

const appEl = document.querySelector("#app");
let loginMessage = "";
let notice = "";
let noticeTimer = null;

const state = {
  loading: true,
  busy: false,
  loggedIn: false,
  teamMode: "join",
  teamCode: "",
  teamName: "",
  userName: "",
  tripDate: nextSaturday(),
  activeScreen: "availability",
  memberId: null,
  members: [],
  currentAvailability: Array(SLOT_COUNT).fill(false),
  availabilityFilter: "all",
  draftMateName: "",
  draftMatePattern: "afternoon",
};

boot();
appEl.addEventListener("click", (e) => void onClick(e));
appEl.addEventListener("input", onInput);

async function boot() {
  render();
  const session = readSession();
  if (session?.teamCode && session?.memberId) {
    try {
      const snapshot = await api(`/api/teams/${encodeURIComponent(session.teamCode)}?memberId=${session.memberId}`);
      applySnapshot(snapshot);
      state.loggedIn = true;
      state.activeScreen = "availability";
    } catch {
      clearSession();
    }
  }
  state.loading = false;
  render();
}

async function onClick(event) {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "set-mode") {
    state.teamMode = el.dataset.mode === "create" ? "create" : "join";
    if (state.teamMode === "create" && !state.teamCode) state.teamCode = makeTeamCode();
    loginMessage = "";
    render();
    return;
  }
  if (action === "submit-login") return handleLogin();
  if (action === "switch-screen") {
    state.activeScreen = SCREEN_META[el.dataset.screen] ? el.dataset.screen : "availability";
    render();
    return;
  }
  if (action === "logout") {
    clearSession();
    state.loggedIn = false;
    state.memberId = null;
    state.members = [];
    state.currentAvailability = Array(SLOT_COUNT).fill(false);
    state.activeScreen = "availability";
    render();
    return;
  }
  if (action === "toggle-slot") {
    const idx = Number(el.dataset.index);
    if (!Number.isNaN(idx) && idx >= 0 && idx < SLOT_COUNT) {
      state.currentAvailability[idx] = !state.currentAvailability[idx];
      render();
    }
    return;
  }
  if (action === "quick-preset") {
    applyPreset(el.dataset.preset || "");
    return;
  }
  if (action === "toggle-filter") {
    state.availabilityFilter = state.availabilityFilter === "free" ? "all" : "free";
    render();
    return;
  }
  if (action === "sync") return syncChanges();
  if (action === "set-pattern") {
    state.draftMatePattern = PATTERNS.some((p) => p.id === el.dataset.pattern) ? el.dataset.pattern : "afternoon";
    render();
    return;
  }
  if (action === "add-member") return addMember();
  if (action === "remove-member") return removeMember(el.dataset.id);
  if (action === "copy-code") return copyCode();
  if (action === "download-ics") return downloadIcs();
  if (action === "go-edit") {
    state.activeScreen = "availability";
    render();
  }
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
  if (field === "tripDate") {
    state.tripDate = /^\d{4}-\d{2}-\d{2}$/.test(event.target.value) ? event.target.value : nextSaturday();
    return;
  }
  if (field === "draftMateName") {
    const text = String(event.target.value || "").slice(0, 16);
    state.draftMateName = text;
    event.target.value = text;
    return;
  }
  state[field] = event.target.value;
}

async function handleLogin() {
  const name = sanitizeName(state.userName);
  if (!name) {
    loginMessage = "请输入昵称后再继续。";
    render();
    return;
  }
  state.userName = name;
  if (state.teamMode === "join") {
    const code = sanitizeCode(state.teamCode);
    if (!code || code.length < 4) {
      loginMessage = "请输入至少 4 位团队口令。";
      render();
      return;
    }
    state.teamCode = code;
  } else {
    const team = sanitizeTeam(state.teamName);
    if (!team) {
      loginMessage = "请输入团队名称。";
      render();
      return;
    }
    state.teamName = team;
  }

  state.busy = true;
  render();
  try {
    const snapshot =
      state.teamMode === "join"
        ? await api("/api/teams/join", { method: "POST", body: { teamCode: state.teamCode, userName: state.userName } })
        : await api("/api/teams", {
            method: "POST",
            body: { teamName: state.teamName, userName: state.userName, tripDate: state.tripDate },
          });
    applySnapshot(snapshot);
    state.loggedIn = true;
    state.activeScreen = "availability";
    loginMessage = "";
    saveSession();
    showNotice(state.teamMode === "join" ? "加入团队成功。" : `团队已创建，口令 ${state.teamCode}`);
  } catch (err) {
    loginMessage = err.message || "登录失败。";
  } finally {
    state.busy = false;
    render();
  }
}

async function syncChanges() {
  if (!state.loggedIn || !state.memberId || !state.teamCode) return;
  state.busy = true;
  render();
  try {
    await api(`/api/teams/${encodeURIComponent(state.teamCode)}?memberId=${state.memberId}`, {
      method: "PATCH",
      body: { teamName: state.teamName, tripDate: state.tripDate },
    });
    const snapshot = await api(`/api/teams/${encodeURIComponent(state.teamCode)}/members/${state.memberId}/availability`, {
      method: "PUT",
      body: { availability: state.currentAvailability },
    });
    applySnapshot(snapshot);
    saveSession();
    showNotice("已同步到数据库。");
  } catch (err) {
    showNotice(err.message || "同步失败。");
  } finally {
    state.busy = false;
    render();
  }
}

async function addMember() {
  const name = sanitizeName(state.draftMateName);
  if (!name || !state.teamCode) return showNotice("请先输入成员昵称。");
  state.busy = true;
  render();
  try {
    const snapshot = await api(`/api/teams/${encodeURIComponent(state.teamCode)}/members?memberId=${state.memberId || ""}`, {
      method: "POST",
      body: { name, pattern: state.draftMatePattern },
    });
    state.draftMateName = "";
    applySnapshot(snapshot);
    showNotice("成员已添加。");
  } catch (err) {
    showNotice(err.message || "添加失败。");
  } finally {
    state.busy = false;
    render();
  }
}

async function removeMember(idText) {
  const id = Number(idText);
  if (!Number.isInteger(id) || !state.teamCode) return;
  state.busy = true;
  render();
  try {
    const snapshot = await api(`/api/teams/${encodeURIComponent(state.teamCode)}/members/${id}?memberId=${state.memberId || ""}`, {
      method: "DELETE",
    });
    applySnapshot(snapshot);
    showNotice("成员已移除。");
  } catch (err) {
    showNotice(err.message || "移除失败。");
  } finally {
    state.busy = false;
    render();
  }
}

async function copyCode() {
  if (!state.teamCode) return showNotice("当前没有可复制口令。");
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(state.teamCode);
    else {
      const input = document.createElement("input");
      input.value = state.teamCode;
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    showNotice("团队口令已复制。");
  } catch {
    showNotice("复制失败，请手动记录。");
  }
}

function downloadIcs() {
  const members = allMembers();
  const best = bestWindow(counts(members), members.length);
  if (!best.hasAvailability) return showNotice("当前没有可导出的推荐时段。");
  const title = `${state.teamName || "团队"} 出游活动`;
  const desc = `自动推荐时段：${slotLabel(best.start)} - ${slotLabel(best.end)}。`;
  const start = slotDate(state.tripDate, best.start);
  const end = slotDate(state.tripDate, best.end);
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Team Time//Trip Planner//CN",
    "BEGIN:VEVENT",
    `UID:${Date.now()}@teamtime.local`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(title)}`,
    `DESCRIPTION:${icsText(desc)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
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

function applyPreset(preset) {
  if (preset === "clear") state.currentAvailability = Array(SLOT_COUNT).fill(false);
  else if (preset === "all") state.currentAvailability = Array(SLOT_COUNT).fill(true);
  else if (preset === "afternoon") state.currentAvailability = fromRanges([[8, 20]]);
  else if (preset === "follow-hot") {
    const c = counts(allMembers());
    const threshold = Math.max(1, Math.ceil(allMembers().length * 0.6));
    state.currentAvailability = c.map((v) => v >= threshold);
  }
  render();
}

function render() {
  if (state.loading) {
    appEl.innerHTML = `<div class="login-panel"><section class="login-screen"><div class="login-hero"><div class="logo-badge"><span class="material-symbols-outlined">hourglass</span></div><h1>正在连接...</h1></div></section></div>`;
    return;
  }
  appEl.innerHTML = state.loggedIn ? renderApp() : renderLogin();
}

function renderLogin() {
  return `<div class="login-panel"><section class="login-screen">
    <div class="login-hero"><div class="logo-badge"><span class="material-symbols-outlined">calendar_today</span></div><div class="hero-chip">后端 + 数据库</div><h1>出游时光机</h1><p>创建或加入团队后，所有排期数据都会写入数据库。</p></div>
    <section class="login-card">
      <div class="mode-switch">
        <button class="mode-pill ${state.teamMode === "join" ? "active" : ""}" data-action="set-mode" data-mode="join">加入团队</button>
        <button class="mode-pill ${state.teamMode === "create" ? "active" : ""}" data-action="set-mode" data-mode="create">创建团队</button>
      </div>
      <div class="field-wrap">
        <div class="field"><label>你的昵称</label><div class="field-box"><span class="material-symbols-outlined">person</span><input data-field="userName" value="${a(state.userName)}" placeholder="例如 小林" /></div></div>
        ${
          state.teamMode === "join"
            ? `<div class="field"><label>团队口令</label><div class="field-box"><span class="material-symbols-outlined">key</span><input data-field="teamCode" maxlength="6" value="${a(state.teamCode)}" placeholder="例如 M8K2" /></div></div>`
            : `<div class="field"><label>团队名称</label><div class="field-box"><span class="material-symbols-outlined">groups</span><input data-field="teamName" value="${a(state.teamName)}" placeholder="例如 周末出游团" /></div></div><div class="field"><label>团队口令（自动）</label><div class="field-box readonly-box"><span class="material-symbols-outlined">password</span><input readonly value="${a(state.teamCode || "创建后生成")}" /></div></div>`
        }
        <div class="field"><label>计划日期</label><div class="field-box"><span class="material-symbols-outlined">event</span><input data-field="tripDate" type="date" value="${a(state.tripDate)}" /></div></div>
      </div>
      <div class="login-actions"><button class="primary-btn" data-action="submit-login" ${state.busy ? "disabled" : ""}>${state.busy ? "处理中..." : state.teamMode === "join" ? "加入并开始排期" : "创建团队并开始"}<span class="material-symbols-outlined">arrow_forward</span></button></div>
      ${loginMessage ? `<div class="toast">${h(loginMessage)}</div>` : `<p class="hint">团队数据会持久保存到 SQLite 数据库。</p>`}
    </section>
  </section></div>`;
}

function renderApp() {
  const meta = SCREEN_META[state.activeScreen];
  return `<div class="app-panel">
    <header class="top-bar">
      <div class="title-wrap"><span class="material-symbols-outlined title-icon" style="font-variation-settings:'FILL' 1;">${meta.icon}</span><div class="header-meta"><h1 class="title-main">${meta.title}</h1><p class="title-sub">${meta.subtitle}</p></div></div>
      <div class="header-actions">${state.teamCode ? `<button class="icon-btn" data-action="copy-code"><span class="material-symbols-outlined">content_copy</span></button>` : ""}<button class="icon-btn" data-action="logout"><span class="material-symbols-outlined">logout</span></button></div>
    </header>
    <main class="screen-body">
      <div class="team-chip-row"><span class="team-chip">团队：${h(state.teamName || "未命名团队")}</span>${state.teamCode ? `<span class="team-chip">口令：${h(state.teamCode)}</span>` : ""}</div>
      ${notice ? `<div class="toast">${h(notice)}</div>` : ""}
      ${state.activeScreen === "availability" ? sectionAvailability() : state.activeScreen === "heatmap" ? sectionHeatmap() : sectionSummary()}
    </main>
    ${nav()}
  </div>`;
}

function sectionAvailability() {
  const members = allMembers();
  const c = counts(members);
  const selected = state.currentAvailability.filter(Boolean).length;
  const indexes = state.availabilityFilter === "free" ? SLOT_LABELS.map((_, i) => i).filter((i) => state.currentAvailability[i]) : SLOT_LABELS.map((_, i) => i);
  return `<section>
    <p class="section-label">当前状态</p><h2 class="section-title">我的空闲安排</h2>
    <article class="hero-card"><p class="section-label" style="color:rgba(255,255,255,.82);margin:0;">已选择空闲时长</p><div class="hero-value"><strong>${hours(selected)}</strong><span>小时</span></div><p class="hero-meta">${dateText(state.tripDate)} · 点选时段切换</p></article>
    <article class="utility-card"><div class="date-row"><span class="material-symbols-outlined">calendar_month</span><input class="date-input" data-field="tripDate" type="date" value="${a(state.tripDate)}" /></div>
      <div class="quick-actions"><button class="quick-btn" data-action="quick-preset" data-preset="clear">清空</button><button class="quick-btn" data-action="quick-preset" data-preset="all">全天</button><button class="quick-btn" data-action="quick-preset" data-preset="afternoon">下午优先</button><button class="quick-btn" data-action="quick-preset" data-preset="follow-hot">跟随热门</button></div>
      <button class="filter-btn" data-action="toggle-filter">${state.availabilityFilter === "free" ? "显示全部时段" : "只看已选择时段"}</button>
    </article>
    <div class="legend"><span class="legend-item"><i class="legend-dot dot-free"></i>已设为空闲</span><span class="legend-item"><i class="legend-dot dot-mid"></i>团队热门</span><span class="legend-item"><i class="legend-dot dot-busy"></i>低重叠</span></div>
    ${indexes.length ? `<div class="slot-list">${indexes.map((i) => {
      const free = state.currentAvailability[i];
      const ratio = c[i] / members.length;
      const level = free ? "available" : ratio >= 0.6 ? "mid" : "busy";
      return `<button class="slot-row ${level}" data-action="toggle-slot" data-index="${i}"><span class="slot-time">${SLOT_LABELS[i]}</span><span class="slot-content"><span class="slot-title">${free ? "空闲，可参加" : ratio >= 0.6 ? "团队热门，建议空出" : "忙碌"}</span><span class="slot-hint">${free ? "点击切换为忙碌" : "点击标记为可参加"}</span></span><span class="material-symbols-outlined">${free ? "check_circle" : "add_circle"}</span></button>`;
    }).join("")}</div>` : `<div class="empty-tip">当前没有已选择时段，点击“显示全部时段”继续编辑。</div>`}
    <div class="floating-save"><button class="primary-btn" data-action="sync" ${state.busy ? "disabled" : ""}><span class="material-symbols-outlined">sync</span>${state.busy ? "同步中..." : "保存并同步"}</button></div>
  </section>`;
}

function sectionHeatmap() {
  const members = allMembers();
  const teammates = members.filter((m) => m.id !== state.memberId);
  const c = counts(members);
  const top = [...Array(SLOT_COUNT).keys()].sort((a, b) => (c[b] - c[a]) || (a - b)).slice(0, 10);
  return `<section>
    <div class="heatmap-head"><div><p class="section-label">团队概览</p><h2 class="section-title" style="margin-bottom:0;">${members.length} 人时段热力</h2></div><span class="section-label" style="letter-spacing:.04em;">${dateText(state.tripDate)}</span></div>
    ${teammates.length ? "" : `<article class="empty-state-card"><h3>当前仅有你 1 人</h3><p>分享口令后可获得真实热力图，也可先补录成员模拟排期。</p>${state.teamCode ? `<button class="secondary-btn" data-action="copy-code">复制团队口令</button>` : ""}</article>`}
    <article class="overview-card"><div class="heat-strip">${c.map((x) => `<span class="heat-cell ${heatLevel(x, members.length)}"></span>`).join("")}</div><div class="heat-axis"><span>${SLOT_LABELS[0]}</span><span>12:00</span><span>16:00</span><span>${SLOT_LABELS[SLOT_COUNT - 1]}</span></div></article>
    <p class="section-label" style="margin-top:16px;">重叠时段 Top 10</p>
    <div class="distribution-list">${top.map((i) => {
      const row = members.filter((m) => m.availability[i]);
      const show = row.slice(0, 3);
      const extra = row.length - show.length;
      return `<article class="distribution-row ${heatLevel(c[i], members.length) === "heat-high" ? "high" : ""}"><p class="distribution-time">${SLOT_LABELS[i]}</p><div class="distribution-main"><span class="availability-chip ${chipLevel(heatLevel(c[i], members.length))}">${c[i]}/${members.length} 人空闲</span><div class="member-stack">${show.map((m) => `<img src="${avatar(m.id)}" alt="${a(m.name)}" />`).join("")}${extra > 0 ? `<span>+${extra}</span>` : ""}</div></div><span class="material-symbols-outlined">chevron_right</span></article>`;
    }).join("")}</div>
    <section class="teammate-editor"><p class="section-label">补录成员（写入数据库）</p><div class="field-box" style="margin-top:10px;"><span class="material-symbols-outlined">person_add</span><input data-field="draftMateName" value="${a(state.draftMateName)}" placeholder="输入成员昵称，例如 小周" /></div>
      <div class="pattern-grid">${PATTERNS.map((p) => `<button class="pattern-btn ${state.draftMatePattern === p.id ? "active" : ""}" data-action="set-pattern" data-pattern="${p.id}">${p.label}</button>`).join("")}</div>
      <button class="secondary-btn" style="margin-top:10px;" data-action="add-member" ${state.busy ? "disabled" : ""}>${state.busy ? "处理中..." : "添加到团队"}</button>
      ${teammates.length ? `<div class="teammate-list">${teammates.map((m) => `<article class="teammate-item"><img class="avatar" src="${avatar(m.id)}" alt="${a(m.name)}" /><div class="teammate-info"><strong>${h(m.name)}</strong><span>已标记 ${hours(m.availability.filter(Boolean).length)} 小时空闲</span></div><button class="danger-btn" data-action="remove-member" data-id="${m.id}" ${state.busy ? "disabled" : ""}><span class="material-symbols-outlined">delete</span></button></article>`).join("")}</div>` : ""}
    </section>
  </section>`;
}

function sectionSummary() {
  const members = allMembers();
  const best = bestWindow(counts(members), members.length);
  if (!best.hasAvailability) {
    return `<section><article class="empty-state-card"><h3>还没有可推荐时段</h3><p>请先补充可用时间并同步到数据库。</p><button class="primary-btn" data-action="go-edit"><span class="material-symbols-outlined">edit_calendar</span>去补充时段</button></article></section>`;
  }
  const duration = best.end - best.start;
  const full = members.filter((m) => {
    for (let i = best.start; i < best.end; i++) if (!m.availability[i]) return false;
    return true;
  }).length;
  return `<section>
    <article class="summary-banner"><div class="summary-figure"></div><p class="section-label" style="margin-bottom:6px;">排期结果</p><h2 class="section-title" style="margin-bottom:4px;">最佳连续时段已生成</h2><p style="margin:0;color:var(--on-surface-variant);font-size:.88rem;font-weight:600;">基于数据库中的团队时段计算。</p></article>
    <article class="best-window"><span class="best-tag"><span class="material-symbols-outlined" style="font-size:15px;font-variation-settings:'FILL' 1;">auto_awesome</span>推荐时段</span><h3>${slotLabel(best.start)} - ${slotLabel(best.end)}</h3><p>${dateText(state.tripDate)} · 连续 ${duration * SLOT_STEP} 分钟</p><p>${full}/${members.length} 位成员可全程参加</p></article>
    <p class="section-label" style="margin-top:18px;">参与成员</p>
    <div class="attendee-grid">${members.map((m) => {
      const n = countRange(m.availability, best.start, best.end);
      const s = n === duration ? ["status-full", "全程可参加"] : n > 0 ? ["status-partial", `可参加 ${n * SLOT_STEP} 分钟`] : ["status-none", "不可参加"];
      return `<article class="attendee-card"><img class="avatar" src="${avatar(m.id)}" alt="${a(m.name)}" /><div class="attendee-main"><p class="attendee-name">${h(m.name)}</p><p class="attendee-meta">${h(m.role)}</p></div><span class="status-pill ${s[0]}">${s[1]}</span></article>`;
    }).join("")}</div>
    <div class="action-stack"><button class="primary-btn" data-action="download-ics"><span class="material-symbols-outlined">calendar_add_on</span>添加到日历</button><button class="secondary-btn" data-action="go-edit">返回调整时段</button></div>
  </section>`;
}

function nav() {
  const items = [
    ["availability", "可用", "event_available"],
    ["heatmap", "团队", "grid_view"],
    ["summary", "总结", "insights"],
  ];
  return `<nav class="bottom-nav">${items.map(([id, label, icon]) => `<button class="nav-item ${state.activeScreen === id ? "active" : ""}" data-action="switch-screen" data-screen="${id}"><span class="material-symbols-outlined" ${state.activeScreen === id ? `style="font-variation-settings:'FILL' 1;"` : ""}>${icon}</span><span>${label}</span></button>`).join("")}</nav>`;
}

function applySnapshot(snapshot) {
  if (!snapshot?.team) return;
  state.teamCode = snapshot.team.code || state.teamCode;
  state.teamName = snapshot.team.name || state.teamName;
  state.tripDate = snapshot.team.tripDate || state.tripDate;
  state.members = Array.isArray(snapshot.members)
    ? snapshot.members.map((m) => ({ id: Number(m.id), name: String(m.name || ""), role: String(m.role || "成员"), availability: normalizeAvailability(m.availability) }))
    : [];
  if (snapshot.currentMember) {
    state.memberId = Number(snapshot.currentMember.id);
    state.userName = snapshot.currentMember.name || state.userName;
  }
  const me = state.members.find((m) => m.id === state.memberId);
  if (me) state.currentAvailability = normalizeAvailability(me.availability);
}

function allMembers() {
  if (!state.members.length) {
    return [{ id: state.memberId || 0, name: state.userName || "你", role: "你", availability: normalizeAvailability(state.currentAvailability) }];
  }
  return state.members.map((m) => (m.id === state.memberId ? { ...m, name: state.userName || m.name, availability: normalizeAvailability(state.currentAvailability) } : { ...m, availability: normalizeAvailability(m.availability) }));
}

function counts(members) {
  return SLOT_LABELS.map((_, i) => members.reduce((sum, m) => sum + (m.availability[i] ? 1 : 0), 0));
}

function bestWindow(c, total) {
  if (c.every((x) => x === 0)) return { start: 0, end: 2, hasAvailability: false };
  let best = { start: 0, end: 2, score: -Infinity, hasAvailability: true };
  for (let s = 0; s < c.length - 1; s++) {
    for (let len = 2; len <= 8 && s + len <= c.length; len++) {
      const seg = c.slice(s, s + len);
      const min = Math.min(...seg);
      const avg = seg.reduce((a, b) => a + b, 0) / len;
      let score = min * 18 + avg * 5 + len;
      if (min === 0) score -= 100;
      if (min === total) score += 25;
      if (len > 4) score -= (len - 4) * 2;
      if (score > best.score) best = { start: s, end: s + len, score, hasAvailability: true };
    }
  }
  return best;
}

function countRange(arr, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) if (arr[i]) n++;
  return n;
}

function fromRanges(ranges) {
  const out = Array(SLOT_COUNT).fill(false);
  ranges.forEach(([s, e]) => { for (let i = s; i < e && i < SLOT_COUNT; i++) if (i >= 0) out[i] = true; });
  return out;
}

function heatLevel(count, total) {
  if (total <= 1) return count > 0 ? "heat-high" : "heat-low";
  const ratio = count / total;
  return ratio >= 0.68 ? "heat-high" : ratio >= 0.4 ? "heat-mid" : "heat-low";
}

function chipLevel(level) {
  return level === "heat-high" ? "high" : level === "heat-mid" ? "mid" : "low";
}

async function api(path, options = {}) {
  const config = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, config);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

function showNotice(text) {
  notice = text;
  render();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = "";
    render();
  }, 2200);
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

function normalizeAvailability(v) {
  if (!Array.isArray(v)) return Array(SLOT_COUNT).fill(false);
  const out = Array(SLOT_COUNT).fill(false);
  for (let i = 0; i < SLOT_COUNT; i++) out[i] = Boolean(v[i]);
  return out;
}

function sanitizeName(v) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function sanitizeTeam(v) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, 30);
}

function sanitizeCode(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
}

function makeTeamCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function slotLabel(index) {
  const total = START_MIN + index * SLOT_STEP;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function slotDate(dateIso, idx) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const date = new Date(y, m - 1, d, 8, 0, 0, 0);
  date.setMinutes(date.getMinutes() + idx * SLOT_STEP);
  return date;
}

function icsDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dateText(iso) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(`${iso}T12:00:00`));
}

function hours(slots) {
  const value = slots / 2;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function avatar(seed) {
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed || "member")}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
}

function nextSaturday() {
  const d = new Date();
  let add = (6 - d.getDay() + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function h(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function a(s) {
  return h(s).replaceAll("`", "&#96;");
}

function icsText(s) {
  return String(s).replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\n", "\\n");
}

