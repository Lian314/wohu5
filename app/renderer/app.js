const DANMAKU_ENDPOINT = "http://localhost:3000/api/danmaku";
const AI_ENDPOINT = "http://localhost:3000/api/danmaku-review";
const MIN_OPACITY = 0.18;
const HOT_ACTIVE_MS = 30000;
const WINDOW_MS = 60000;
const CONTROL_WINDOW_MS = 45000;
const MEME_MATCH_THRESHOLD = 0.54;
const markedKey = "huya-marked-memes";
const blockedKey = "huya-blocked-memes";

const TEAM_ALIASES = {
    T1: ["t1", "skt"],
    BLG: ["blg", "哔哩哔哩"],
    TES: ["tes", "滔搏"],
    JDG: ["jdg", "京东"],
    GEN: ["gen", "geng", "三星"],
    HLE: ["hle", "韩华"],
    DK: ["dk", "dwg"],
    WBG: ["wbg", "微博"],
    LNG: ["lng"],
    EDG: ["edg"],
    RNG: ["rng"],
    IG: ["ig"],
    WE: ["we"],
    FPX: ["fpx"],
    G2: ["g2"],
    FNC: ["fnc"],
    KT: ["kt"],
    KDF: ["kdf"],
    AL: ["al"],
    NIP: ["nip"],
    OMG: ["omg"]
};

const TOXIC_KEYWORDS = [
    "丑", "恶心", "傻逼", "傻比", "sb", "煞笔", "废物", "滚", "脑残", "司马", "死妈",
    "畜生", "fw", "垃圾", "没妈", "下头", "弱智", "蠢", "丢人", "÷"
];

const state = {
    raw: [],
    groups: [],
    pinned: [],
    fresh: [],
    selectedKey: "",
    windowMs: WINDOW_MS,
    opacity: 1,
    marked: readStore(markedKey),
    blocked: readStore(blockedKey),
    seeded: [],
    ragCache: new Map(),
    ragLoading: false,
    ragStatus: null,
    seedParsing: false,
    seedDocument: null,
    libraryTab: "marked",
    roomProfile: null,
    controlSuggestion: null,
    dismissedControlKey: ""
};

const pinnedList = document.getElementById("pinned-list");
const freshList = document.getElementById("fresh-list");
const pinnedCount = document.getElementById("pinned-count");
const freshCount = document.getElementById("fresh-count");
const statusEl = document.getElementById("connection-status");
const roomLabel = document.getElementById("room-label");
const toastEl = document.getElementById("toast");
const roomButton = document.getElementById("room-button");
const roomPopover = document.getElementById("room-popover");
const roomForm = document.getElementById("room-form");
const roomInput = document.getElementById("room-input");
const roomMessage = document.getElementById("room-message");
const libraryButton = document.getElementById("library-button");
const libraryPanel = document.getElementById("library-panel");
const libraryClose = document.getElementById("library-close");
const libraryList = document.getElementById("library-list");
const controlPanel = document.getElementById("control-panel");
const controlType = document.getElementById("control-type");
const controlLine = document.getElementById("control-line");
const controlReason = document.getElementById("control-reason");
const controlCopy = document.getElementById("control-copy");
const controlDismiss = document.getElementById("control-dismiss");

setupWindowControls();
setupRoomControls();
setupLibraryControls();
setupControlControls();
setupOpacityWheel();
loadRagLibrary();
fetchDanmaku();
window.setInterval(fetchDanmaku, 1000);

async function setupWindowControls() {
    const desktop = window.desktopWindow;
    const pin = document.getElementById("pin-window");
    if (!desktop) return;

    document.getElementById("minimize-window").addEventListener("click", () => desktop.minimize());
    document.getElementById("close-window").addEventListener("click", () => desktop.close());
    pin.addEventListener("click", async () => {
        const pinned = await desktop.toggleAlwaysOnTop();
        pin.classList.toggle("active", pinned);
        showToast(pinned ? "窗口已置顶" : "已取消置顶");
    });

    const desktopState = await desktop.getState();
    state.opacity = desktopState.opacity || state.opacity;
    syncSolidFactor();
    pin.classList.toggle("active", Boolean(desktopState.isAlwaysOnTop));

    const backend = await desktop.getBackendState();
    updateBackendStatus(backend);
    desktop.onBackendStatus(updateBackendStatus);
}

function setupRoomControls() {
    roomButton.addEventListener("click", () => {
        roomPopover.hidden = !roomPopover.hidden;
        if (!roomPopover.hidden) {
            roomInput.focus();
            roomInput.select();
        }
    });

    roomForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const roomId = roomInput.value.trim();
        if (!roomId) return;

        roomMessage.textContent = "正在连接...";
        try {
            const result = await window.desktopWindow.connectRoom(roomId);
            updateBackendStatus(result);
            roomPopover.hidden = true;
            showToast(`已连接 ${roomId}`);
        } catch (error) {
            roomMessage.textContent = error.message || "连接失败";
        }
    });

    window.addEventListener("pointerdown", (event) => {
        if (!roomPopover.hidden && !roomPopover.contains(event.target) && !roomButton.contains(event.target)) {
            roomPopover.hidden = true;
        }
        if (!libraryPanel.hidden && !libraryPanel.contains(event.target) && !libraryButton.contains(event.target)) {
            libraryPanel.hidden = true;
        }
    });
}

function setupLibraryControls() {
    libraryButton.addEventListener("click", () => {
        libraryPanel.hidden = !libraryPanel.hidden;
        renderLibrary();
    });
    libraryClose.addEventListener("click", () => {
        libraryPanel.hidden = true;
    });
    document.querySelectorAll("[data-library-tab]").forEach((button) => {
        button.addEventListener("click", () => {
            state.libraryTab = button.dataset.libraryTab;
            document.querySelectorAll("[data-library-tab]").forEach((item) => {
                item.classList.toggle("active", item === button);
            });
            renderLibrary();
        });
    });
}

function setupControlControls() {
    controlCopy.addEventListener("click", async () => {
        if (!state.controlSuggestion) return;
        await copyText(state.controlSuggestion.line);
        controlCopy.textContent = "待发送";
        showToast("控场弹幕已复制");
    });
    controlDismiss.addEventListener("click", () => {
        if (state.controlSuggestion) {
            state.dismissedControlKey = state.controlSuggestion.key;
        }
        renderControlPanel();
    });
}

function updateBackendStatus(info) {
    if (!info) return;
    statusEl.textContent = info.status || "未知";
    roomLabel.textContent = info.roomId ? `直播间 ${info.roomId}` : "未选择直播间";
    state.roomProfile = info.roomProfile || state.roomProfile;
    if (info.roomId) {
        roomInput.value = info.roomId;
    }
}

async function loadRagLibrary() {
    try {
        const data = await listMemeRag();
        state.ragStatus = data;
        state.seeded = Array.isArray(data.items) ? data.items : [];
        if (!libraryPanel.hidden && state.libraryTab === "seeded") {
            renderLibrary();
        }
    } catch (error) {
        state.ragStatus = {
            error: error.message || "外接热梗库不可用",
            baseUrl: "http://localhost:3100"
        };
        state.seeded = [];
    }
}

async function listMemeRag() {
    if (window.desktopWindow && window.desktopWindow.listMemeRag) {
        return window.desktopWindow.listMemeRag();
    }
    const response = await fetch("http://localhost:3000/api/meme-rag/items", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function matchMemeRag(text) {
    if (window.desktopWindow && window.desktopWindow.matchMemeRag) {
        return window.desktopWindow.matchMemeRag({ text, threshold: MEME_MATCH_THRESHOLD, limit: 1 });
    }
    const response = await fetch("http://localhost:3000/api/meme-rag/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, threshold: MEME_MATCH_THRESHOLD, limit: 1 })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function upsertMemeRag(items, source = "desktop") {
    if (window.desktopWindow && window.desktopWindow.upsertMemeRag) {
        return window.desktopWindow.upsertMemeRag({ items, source });
    }
    const response = await fetch("http://localhost:3000/api/meme-rag/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, source })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function removeMemeRag(key) {
    if (window.desktopWindow && window.desktopWindow.removeMemeRag) {
        return window.desktopWindow.removeMemeRag(key);
    }
    const response = await fetch(`http://localhost:3000/api/meme-rag/items/${encodeURIComponent(key)}`, {
        method: "DELETE"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function importMemeRag(payload) {
    if (window.desktopWindow && window.desktopWindow.importMemeRag) {
        return window.desktopWindow.importMemeRag(payload);
    }
    const response = await fetch("http://localhost:3000/api/meme-rag/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function assertRagOk(result) {
    if (result && result.code === "EXTERNAL_RAG_UNAVAILABLE") {
        throw new Error(`外接热梗库未启动：${result.baseUrl || "http://localhost:3100"}`);
    }
    if (result && result.error) {
        throw new Error(result.error);
    }
}

function setupOpacityWheel() {
    window.addEventListener("wheel", async (event) => {
        if (!event.ctrlKey || !window.desktopWindow) return;
        event.preventDefault();
        const step = event.deltaY < 0 ? 0.04 : -0.04;
        state.opacity = normalizeOpacity(state.opacity + step);
        state.opacity = await window.desktopWindow.setOpacity(state.opacity);
        syncSolidFactor();
        showToast(`不透明度 ${Math.round(state.opacity * 100)}%`);
    }, { passive: false });
}

function syncSolidFactor() {
    const normalized = (normalizeOpacity(state.opacity) - MIN_OPACITY) / (1 - MIN_OPACITY);
    document.documentElement.style.setProperty("--solid-factor", String(Math.max(0, Math.min(1, normalized))));
}

function normalizeOpacity(value) {
    const next = Number(value) || 1;
    if (next >= 0.985) return 1;
    return Math.max(MIN_OPACITY, Math.min(1, next));
}

async function fetchDanmaku() {
    try {
        const list = await readDanmakuList();
        state.raw = Array.isArray(list) ? list.map(normalizeMessage).filter(Boolean) : [];
        statusEl.textContent = "进行中";
        await refreshStats();
    } catch (error) {
        state.raw = [];
        state.groups = [];
        state.pinned = [];
        state.fresh = [];
        state.controlSuggestion = null;
        statusEl.textContent = "离线";
        renderStats();
    }
}

async function readDanmakuList() {
    if (window.desktopWindow && window.desktopWindow.getDanmaku) {
        return window.desktopWindow.getDanmaku();
    }

    const response = await fetch(DANMAKU_ENDPOINT, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function normalizeMessage(item, index) {
    if (!item || !item.content) return null;
    const timestamp = normalizeTimestamp(item.timestamp, Date.now());
    return {
        id: item.id || `${timestamp}-${index}`,
        nickname: item.nickname || "虎牙用户",
        content: String(item.content).trim(),
        timestamp,
        sourceTimestamp: normalizeTimestamp(item.sourceTimestamp, timestamp)
    };
}

function normalizeTimestamp(value, fallback) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.getTime();
    }
    if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return normalizeTimestamp(numeric, fallback);
        }
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    if (Number.isFinite(value)) {
        if (value > 0 && value < 100000000000) {
            return Math.round(value * 1000);
        }
        if (value > 0) {
            return Math.round(value);
        }
    }
    return fallback;
}

async function refreshStats() {
    await rebuildGroups();
    renderStats();
}

async function rebuildGroups() {
    const now = Date.now();
    const source = state.raw
        .filter((item) => now - item.timestamp <= state.windowMs)
        .filter((item) => !isBlocked(item.content));
    const map = new Map();

    source.forEach((item) => {
        const key = normalizeContent(item.content);
        if (!key) return;

        if (!map.has(key)) {
            map.set(key, {
                key,
                content: item.content,
                count: 0,
                firstAt: item.timestamp,
                latestAt: item.timestamp,
                nicknames: new Set(),
                samples: []
            });
        }

        const group = map.get(key);
        group.count += 1;
        group.firstAt = Math.min(group.firstAt, item.timestamp);
        group.latestAt = Math.max(group.latestAt, item.timestamp);
        group.nicknames.add(item.nickname);
        group.samples.push(item);
    });

    const enrichedGroups = await Promise.all(Array.from(map.values())
        .map(async (group) => {
            const marked = Boolean(findStored(state.marked, group.key));
            const libraryMatch = await findRagMatch(group.content);
            return {
                ...group,
                uniqueUsers: group.nicknames.size,
                marked,
                libraryMatch,
                ageMs: now - group.latestAt,
                samples: group.samples.sort((a, b) => a.timestamp - b.timestamp)
            };
        }));

    state.groups = enrichedGroups
        .map((group) => ({
            ...group,
            score: heatScore(group),
            tag: buildTag(group)
        }))
        .sort((a, b) => b.latestAt - a.latestAt);

    state.pinned = state.groups
        .filter((group) => group.ageMs <= HOT_ACTIVE_MS)
        .filter((group) => group.marked || group.libraryMatch || group.count >= 2 || group.uniqueUsers >= 2)
        .sort((a, b) => b.score - a.score || b.latestAt - a.latestAt)
        .slice(0, 5);

    const pinnedKeys = new Set(state.pinned.map((group) => group.key));
    state.fresh = state.groups
        .filter((group) => !pinnedKeys.has(group.key))
        .sort((a, b) => b.latestAt - a.latestAt);

    state.controlSuggestion = buildControlSuggestion(source, state.groups);
}

function heatScore(group) {
    const recency = Math.max(0, 1 - group.ageMs / HOT_ACTIVE_MS) * 18;
    const frequency = Math.min(60, group.count * 12);
    const spread = Math.min(20, group.uniqueUsers * 5);
    const marked = group.marked ? 16 : 0;
    const seeded = group.libraryMatch ? Math.round(20 * group.libraryMatch.score) : 0;
    return frequency + spread + recency + marked + seeded;
}

function normalizeContent(content) {
    return String(content)
        .replace(/\s+/g, "")
        .replace(/[!！?？。.,，~～、]+$/g, "")
        .toLowerCase();
}

function buildTag(group) {
    if (group.marked) return "已标记";
    if (group.libraryMatch) return "热梗库";
    if (group.count >= 5) return "高频";
    if (group.uniqueUsers >= 3) return "多人";
    if (group.ageMs <= 15000) return "新";
    return "热词";
}

function renderStats() {
    pinnedCount.textContent = String(state.pinned.length);
    freshCount.textContent = String(state.fresh.length);
    renderControlPanel();

    pinnedList.innerHTML = state.pinned.length
        ? state.pinned.map((group) => renderGroupRow(group, "pinned")).join("")
        : `<div class="empty-state compact-empty">30 秒内的高频弹幕会停留在这里</div>`;

    freshList.innerHTML = state.fresh.length
        ? state.fresh.map((group) => renderGroupRow(group, "fresh")).join("")
        : `<div class="empty-state">等待直播间弹幕进入</div>`;

    bindRowEvents(pinnedList);
    bindRowEvents(freshList);
}

function renderControlPanel() {
    const suggestion = state.controlSuggestion;
    if (!suggestion || suggestion.key === state.dismissedControlKey) {
        controlPanel.hidden = true;
        return;
    }

    controlPanel.hidden = false;
    controlType.textContent = suggestion.typeLabel;
    controlType.dataset.severity = suggestion.severity;
    controlLine.textContent = suggestion.line;
    controlReason.textContent = suggestion.reason;
    controlCopy.textContent = "复制";
}

function renderGroupRow(group, mode) {
    const marked = Boolean(findStored(state.marked, group.key));
    return `
        <div class="stat-row ${mode === "pinned" ? "hot-row" : ""} ${group.key === state.selectedKey ? "active" : ""}" data-key="${escapeAttr(group.key)}" role="button" tabindex="0">
            <span class="row-actions" aria-label="快捷操作">
                <button class="row-tool ${marked ? "active" : ""}" data-action="mark" data-key="${escapeAttr(group.key)}" title="${marked ? "已标记" : "标记到热梗库"}" type="button">★</button>
                <button class="row-tool" data-action="block" data-key="${escapeAttr(group.key)}" title="屏蔽相关弹幕" type="button">⊘</button>
            </span>
            <span class="stat-main">
                <span class="stat-title">
                    <strong>${escapeHtml(group.content)}</strong>
                    <span class="hot-tag">${escapeHtml(group.tag)}</span>
                </span>
                <span class="stat-meta">
                    <span>${formatClock(group.firstAt)} 首次</span>
                    <span>${formatClock(group.latestAt)} 最近</span>
                </span>
            </span>
            <span class="stat-side">
                <span class="count">${group.count}<small>次</small></span>
                ${sparkline(group)}
            </span>
        </div>
    `;
}

function buildControlSuggestion(source, groups) {
    const now = Date.now();
    const recent = source.filter((item) => now - item.timestamp <= CONTROL_WINDOW_MS);
    if (!recent.length) return null;

    const attack = detectPersonalAttack(recent);
    const trend = detectOneSidedTrend(recent);
    if (attack && (!trend || attack.severityScore >= trend.severityScore)) return attack;
    return trend;
}

function detectPersonalAttack(recent) {
    const hits = recent.filter((item) => {
        const text = normalizeContent(item.content);
        return TOXIC_KEYWORDS.some((keyword) => text.includes(keyword));
    });
    if (hits.length < 2 && !(hits.length === 1 && recent.length <= 8)) return null;

    const appearance = hits.some((item) => /丑|颜值|长相|脸|难看|恶心/.test(item.content));
    const line = appearance
        ? "别尬黑了，哥哥这张脸开摄像头就是给弹幕加餐的。"
        : "别把火往人身上带，嘴上留点德，节目效果留给操作。";
    const unique = new Set(hits.map((item) => item.nickname)).size;
    return {
        key: `attack:${hits.length}:${normalizeContent(hits[hits.length - 1].content).slice(0, 18)}`,
        type: "attack",
        typeLabel: "控场",
        severity: hits.length >= 4 || unique >= 3 ? "high" : "medium",
        severityScore: 90 + hits.length * 4 + unique * 3,
        line,
        reason: `${CONTROL_WINDOW_MS / 1000} 秒内识别到 ${hits.length} 条攻击性弹幕，建议先降温再继续节目。`
    };
}

function detectOneSidedTrend(recent) {
    const roomTeams = findTeamsInText(roomContextText());
    const chatTeams = findTeamsInText(recent.map((item) => item.content).join(" "));
    const teams = roomTeams.length >= 2 ? roomTeams : Array.from(new Set([...roomTeams, ...chatTeams])).slice(0, 3);
    if (teams.length < 2) return null;

    const counts = teams.map((team) => ({
        team,
        count: recent.filter((item) => isCheerForTeam(item.content, team)).length
    })).sort((a, b) => b.count - a.count);
    const leader = counts[0];
    const target = counts.find((item) => item.team !== leader.team) || counts[1];
    if (!leader || !target || leader.count < 4) return null;
    if (target.count > Math.max(1, leader.count * 0.38)) return null;

    return {
        key: `trend:${leader.team}:${target.team}:${leader.count}:${target.count}`,
        type: "trend",
        typeLabel: "补弹幕",
        severity: leader.count >= 8 ? "high" : "medium",
        severityScore: 70 + leader.count * 5 - target.count * 2,
        line: `${target.team}粉别潜水了，键盘敲起来，别让${leader.team}把屏幕包圆了。`,
        reason: `直播间像是 ${teams.join(" vs ")} 相关场景，近期“${leader.team}加油”明显压过另一边。`
    };
}

function roomContextText() {
    const profile = state.roomProfile || {};
    return [
        profile.anchorName,
        profile.title,
        profile.category,
        profile.announcement,
        profile.roomId
    ].filter(Boolean).join(" ");
}

function findTeamsInText(text) {
    const normalized = String(text || "").toLowerCase();
    return Object.keys(TEAM_ALIASES).filter((team) => {
        return TEAM_ALIASES[team].some((alias) => {
            const word = alias.toLowerCase();
            if (/^[a-z0-9]+$/.test(word)) {
                return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, "i").test(normalized);
            }
            return normalized.includes(word);
        });
    });
}

function isCheerForTeam(text, team) {
    const source = String(text || "");
    const normalized = source.toLowerCase();
    const hasTeam = TEAM_ALIASES[team].some((alias) => {
        const word = alias.toLowerCase();
        if (/^[a-z0-9]+$/.test(word)) {
            return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, "i").test(normalized);
        }
        return normalized.includes(word);
    });
    return hasTeam && /(加油|冲|赢|牛|必胜|拿下|给我赢|别怂|站起来|干碎)/.test(source);
}

function bindRowEvents(root) {
    root.querySelectorAll(".stat-row").forEach((button) => {
        button.addEventListener("click", () => selectGroup(button.dataset.key));
        button.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectGroup(button.dataset.key);
            }
        });
    });
    root.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const group = state.groups.find((item) => item.key === button.dataset.key);
            if (!group) return;
            if (button.dataset.action === "mark") {
                toggleMark(group);
            } else {
                blockGroup(group);
            }
        });
    });
}

async function toggleMark(group) {
    const existing = findStored(state.marked, group.key);
    if (existing) {
        state.marked = state.marked.filter((item) => item.key !== group.key);
        showToast("已取消标记");
    } else {
        state.marked.unshift({
            key: group.key,
            content: group.content,
            createdAt: Date.now()
        });
        showToast("已加入热梗库");
    }
    state.marked = dedupeStore(state.marked).slice(0, 100);
    writeStore(markedKey, state.marked);
    await refreshStats();
    renderLibrary();
}

async function blockGroup(group) {
    if (!findStored(state.blocked, group.key)) {
        state.blocked.unshift({
            key: group.key,
            content: group.content,
            createdAt: Date.now()
        });
        state.blocked = dedupeStore(state.blocked).slice(0, 100);
        writeStore(blockedKey, state.blocked);
    }
    if (state.selectedKey === group.key) {
        state.selectedKey = "";
    }
    showToast("已屏蔽相关弹幕");
    await refreshStats();
    renderLibrary();
}

function renderLibrary() {
    if (libraryPanel.hidden) return;
    if (state.libraryTab === "seeded") {
        renderSeedLibrary();
        return;
    }

    const data = state.libraryTab === "blocked" ? state.blocked : state.marked;
    if (!data.length) {
        libraryList.innerHTML = `<div class="library-empty">${state.libraryTab === "blocked" ? "暂无屏蔽弹幕" : "暂无标记热梗"}</div>`;
        return;
    }

    libraryList.innerHTML = data.map((item) => `
        <div class="library-item" data-library-open="${escapeAttr(item.key)}" role="button" tabindex="0">
            <span>
                <strong>${escapeHtml(item.content)}</strong>
                <small>${formatDate(item.createdAt)}</small>
            </span>
            <button data-library-remove="${escapeAttr(item.key)}" type="button">${state.libraryTab === "blocked" ? "解除" : "移除"}</button>
        </div>
    `).join("");

    bindLibraryRows();
}

function renderSeedLibrary() {
    const status = state.ragStatus || {};
    const baseUrl = status.baseUrl || "http://localhost:3100";
    const statusText = status.error
        ? `外接库未连接：${status.error}`
        : `外接库已连接 · ${status.count || state.seeded.length} 条`;
    libraryList.innerHTML = `
        <div class="rag-status ${status.error ? "offline" : "online"}">
            <strong>${escapeHtml(statusText)}</strong>
            <small>管理员后台：${escapeHtml(baseUrl)}/rag</small>
        </div>
        <div class="seed-admin">
            <textarea id="seed-bulk-text" rows="4" placeholder="粘贴热梗资料、运营文档、赛事梗整理或直播间黑话"></textarea>
            <div class="seed-admin-actions">
                <label class="seed-file-button" for="seed-file">导入文档</label>
                <input id="seed-file" type="file" accept=".txt,.md,.json,.csv,.log,.docx">
                <button id="seed-parse" type="button">${state.seedParsing ? "解析中..." : "AI解析入库"}</button>
            </div>
        </div>
        <form class="seed-form" id="seed-form">
            <input id="seed-content" autocomplete="off" placeholder="热梗原句">
            <input id="seed-aliases" autocomplete="off" placeholder="别名，用逗号分隔">
            <textarea id="seed-description" rows="2" placeholder="含义/使用场景"></textarea>
            <button type="submit">加入词库</button>
        </form>
        ${state.seeded.length ? state.seeded.map((item) => `
            <div class="library-item seed-item" data-library-open="${escapeAttr(item.key)}" role="button" tabindex="0">
                <span>
                    <strong>${escapeHtml(item.content)}</strong>
                    <small>${escapeHtml(formatSeedMeta(item))}</small>
                </span>
                <button data-library-remove="${escapeAttr(item.key)}" type="button">移除</button>
            </div>
        `).join("") : `<div class="library-empty">先塞几个时代热梗，低频也能被捕捉</div>`}
    `;

    document.getElementById("seed-form").addEventListener("submit", (event) => {
        event.preventDefault();
        addSeedMeme();
    });
    document.getElementById("seed-parse").addEventListener("click", parseSeedMemeText);
    document.getElementById("seed-file").addEventListener("change", loadSeedFile);
    bindLibraryRows();
}

function bindLibraryRows() {
    libraryList.querySelectorAll("[data-library-open]").forEach((row) => {
        row.addEventListener("click", () => openLibraryItem(row.dataset.libraryOpen));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openLibraryItem(row.dataset.libraryOpen);
            }
        });
    });
    libraryList.querySelectorAll("[data-library-remove]").forEach((button) => {
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeLibraryItem(button.dataset.libraryRemove);
        });
    });
}

async function addSeedMeme() {
    const contentInput = document.getElementById("seed-content");
    const aliasesInput = document.getElementById("seed-aliases");
    const descriptionInput = document.getElementById("seed-description");
    const content = contentInput.value.trim();
    if (!content) {
        showToast("先填热梗原句");
        return;
    }

    const item = {
        key: normalizeContent(content),
        content,
        aliases: aliasesInput.value.split(/[，,、/]/).map((value) => value.trim()).filter(Boolean).slice(0, 8),
        description: descriptionInput.value.trim(),
        createdAt: Date.now()
    };
    try {
        const result = await upsertMemeRag([item], "desktop-manual");
        assertRagOk(result);
        state.ragCache.clear();
        await loadRagLibrary();
        showToast("已加入热梗向量库");
        await refreshStats();
        renderLibrary();
    } catch (error) {
        showToast(error.message || "写入向量库失败");
    }
}

async function loadSeedFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
        const buffer = await file.arrayBuffer();
        state.seedDocument = {
            fileName: file.name,
            fileBase64: arrayBufferToBase64(buffer)
        };
        const text = file.name.toLowerCase().endsWith(".docx")
            ? ""
            : new TextDecoder("utf-8").decode(buffer);
        const input = document.getElementById("seed-bulk-text");
        input.value = text ? text.slice(0, 20000) : "";
        showToast(`已导入 ${file.name}`);
    } catch (error) {
        showToast("文档读取失败，请直接粘贴正文");
    } finally {
        event.target.value = "";
    }
}

async function parseSeedMemeText() {
    const input = document.getElementById("seed-bulk-text");
    const text = input.value.trim();
    if (!text && !state.seedDocument) {
        showToast("先粘贴文本或导入文档");
        return;
    }
    if (!window.desktopWindow && !navigator.onLine) {
        showToast("当前环境不支持 AI 解析");
        return;
    }
    state.seedParsing = true;
    renderLibrary();
    try {
        const result = await importMemeRag({
            text,
            ...(state.seedDocument || {})
        });
        assertRagOk(result);
        if (!result.added && !result.parsed) {
            showToast("没有解析出可入库热梗");
            return;
        }
        state.seedDocument = null;
        state.ragCache.clear();
        await loadRagLibrary();
        showToast(`已入库 ${result.added || result.parsed} 条热梗`);
        await refreshStats();
    } catch (error) {
        showToast(error.message || "AI 解析失败");
    } finally {
        state.seedParsing = false;
        renderLibrary();
    }
}

function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
}

async function removeLibraryItem(key) {
    if (state.libraryTab === "blocked") {
        state.blocked = state.blocked.filter((item) => item.key !== key);
        writeStore(blockedKey, state.blocked);
        showToast("已解除屏蔽");
    } else if (state.libraryTab === "seeded") {
        try {
            const result = await removeMemeRag(key);
            assertRagOk(result);
            state.ragCache.clear();
            await loadRagLibrary();
            showToast("已移出向量库");
        } catch (error) {
            showToast(error.message || "删除失败");
            return;
        }
    } else {
        state.marked = state.marked.filter((item) => item.key !== key);
        writeStore(markedKey, state.marked);
        showToast("已移除热梗");
    }
    await refreshStats();
    renderLibrary();
}

function openLibraryItem(key) {
    if (state.libraryTab === "blocked") return;
    const item = state.libraryTab === "seeded"
        ? findStored(state.seeded, key)
        : findStored(state.marked, key);
    if (!item) return;
    const existing = state.groups.find((group) => group.key === key);
    const now = Date.now();
    const group = existing || {
        key: item.key,
        content: item.content,
        count: 1,
        firstAt: item.createdAt || now,
        latestAt: now,
        uniqueUsers: 1,
        samples: [{
            nickname: "热梗库",
            content: item.content,
            timestamp: item.createdAt || now
        }],
        marked: true,
        libraryMatch: state.libraryTab === "seeded" ? { item, score: 1 } : null,
        tag: state.libraryTab === "seeded" ? "热梗库" : "已标记"
    };
    state.selectedKey = key;
    libraryPanel.hidden = true;
    renderStats();
    openDetailForGroup(group);
}

async function selectGroup(key) {
    const group = state.groups.find((item) => item.key === key);
    if (!group) return;

    state.selectedKey = key;
    renderStats();
    openDetailForGroup(group);
}

function openDetailForGroup(group) {
    const payload = {
        group,
        fallback: buildFallbackAi(group),
        aiEndpoint: AI_ENDPOINT,
        reviewPayload: buildReviewPayload(group)
    };

    window.desktopWindow && window.desktopWindow.openDetail(payload);
}

function buildFallbackAi(group) {
    if (group.libraryMatch) {
        const seed = group.libraryMatch.item;
        const description = seed.description || "本地热梗词库命中，说明这条弹幕即使频率不高也值得被主播看见。";
        return {
            explanation: `“${group.content}”命中了热梗词库里的“${seed.content}”。${description}`,
            reason: `相似度 ${Math.round(group.libraryMatch.score * 100)}%，系统已把它从普通新弹幕提升为热梗线索。`,
            reply: `${seed.content}都来了，这波弹幕味儿一下对上了。`,
            interaction: `这梗都能刷出来？懂的别装路人，把屏幕给我点亮。`,
            cooldown: `玩梗可以，别往人身攻击上拐，点到就够了。`
        };
    }

    return {
        explanation: `“${group.content}”在当前时间窗口内快速重复出现，系统已记录首次爆发与最近出现时间，可用于主播接梗和切片打点。`,
        reason: `该弹幕累计出现 ${group.count} 次，参与用户 ${group.uniqueUsers} 人，说明它已经形成值得回应的直播间互动点。`,
        reply: `${group.content}！这波弹幕我看到了，下一波给你们来点更有节目效果的。`,
        interaction: `看到大家都刷起来了，弹幕继续扣一波，让我看看直播间还有多少人在！`,
        cooldown: `大家轻松玩梗就好，咱们把气氛留在开心这边，别上头。`
    };
}

function buildReviewPayload(group) {
    return {
        selectedDanmaku: {
            content: group.content,
            count: group.count,
            firstTimestamp: group.firstAt,
            latestTimestamp: group.latestAt,
            uniqueUsers: group.uniqueUsers
        },
        window: {
            sizeMs: state.windowMs,
            startedAt: Date.now() - state.windowMs,
            endedAt: Date.now()
        },
        samples: group.samples.slice(-30),
        context: state.raw.filter((item) => !isBlocked(item.content)).slice(-80),
        roomProfile: state.roomProfile,
        libraryMatch: group.libraryMatch ? {
            content: group.libraryMatch.item.content,
            aliases: group.libraryMatch.item.aliases || [],
            description: group.libraryMatch.item.description || "",
            score: group.libraryMatch.score
        } : null
    };
}

function isBlocked(content) {
    const key = normalizeContent(content);
    return state.blocked.some((item) => key === item.key || key.includes(item.key) || item.key.includes(key));
}

function findStored(list, key) {
    return list.find((item) => item.key === key);
}

async function findRagMatch(content) {
    const contentKey = normalizeContent(content);
    if (!contentKey) return null;
    const cached = state.ragCache.get(contentKey);
    if (cached && Date.now() - cached.createdAt <= 45000) {
        return cached.value;
    }
    try {
        const result = await matchMemeRag(content);
        const match = result && Array.isArray(result.matches) && result.matches.length
            ? result.matches[0]
            : null;
        const value = match ? { item: match, score: match.score } : null;
        state.ragCache.set(contentKey, { value, createdAt: Date.now() });
        return value;
    } catch (error) {
        return null;
    }
}

function readStore(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(value) ? value.filter((item) => item && item.key && item.content) : [];
    } catch (error) {
        return [];
    }
}

function writeStore(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function dedupeStore(list) {
    const seen = new Set();
    return list.filter((item) => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
    });
}

function sparkline(group) {
    const seed = group.content.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const values = Array.from({ length: 8 }, (_, index) => {
        const wave = Math.sin((seed + index * 13) * 0.42) * 3.4;
        const climb = index * Math.min(2.3, Math.max(0.75, group.count / 13));
        return Math.max(3, Math.min(21, 18 - climb + wave));
    });
    const points = values.map((value, index) => `${index === 0 ? "M" : "L"} ${index * 8.2} ${value.toFixed(1)}`).join(" ");
    return `<svg class="spark" viewBox="0 0 58 16" aria-hidden="true"><path d="${points}"></path></svg>`;
}

function formatClock(timestamp) {
    if (!timestamp) return "--:--";
    const date = new Date(timestamp);
    return `${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function formatDate(timestamp) {
    if (!timestamp) return "--";
    const date = new Date(timestamp);
    return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${formatClock(timestamp)}`;
}

function formatSeedMeta(item) {
    const aliases = Array.isArray(item.aliases) && item.aliases.length ? `别名 ${item.aliases.slice(0, 3).join("/")}` : "无别名";
    const description = item.description ? ` · ${item.description}` : "";
    return `${aliases}${description}`;
}

async function copyText(text) {
    if (window.desktopWindow && window.desktopWindow.copyText) {
        await window.desktopWindow.copyText(text);
        return;
    }
    await navigator.clipboard.writeText(text);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
}

function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toastEl.classList.remove("show"), 1200);
}
