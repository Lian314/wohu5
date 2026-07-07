const DANMAKU_ENDPOINT = "http://localhost:3000/api/danmaku";
const AI_ENDPOINT = "http://localhost:3000/api/danmaku-review";
const MIN_OPACITY = 0.18;
const HOT_ACTIVE_MS = 30000;
const WINDOW_MS = 60000;
const markedKey = "huya-marked-memes";
const blockedKey = "huya-blocked-memes";

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
    libraryTab: "marked"
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

setupWindowControls();
setupRoomControls();
setupLibraryControls();
setupOpacityWheel();
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

function updateBackendStatus(info) {
    if (!info) return;
    statusEl.textContent = info.status || "未知";
    roomLabel.textContent = info.roomId ? `直播间 ${info.roomId}` : "未选择直播间";
    if (info.roomId) {
        roomInput.value = info.roomId;
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
        const response = await fetch(DANMAKU_ENDPOINT, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const list = await response.json();
        state.raw = Array.isArray(list) ? list.map(normalizeMessage).filter(Boolean) : [];
        statusEl.textContent = "进行中";
        rebuildGroups();
        renderStats();
    } catch (error) {
        state.raw = [];
        state.groups = [];
        state.pinned = [];
        state.fresh = [];
        statusEl.textContent = "离线";
        renderStats();
    }
}

function normalizeMessage(item, index) {
    if (!item || !item.content) return null;
    return {
        id: item.id || `${item.timestamp || Date.now()}-${index}`,
        nickname: item.nickname || "虎牙用户",
        content: String(item.content).trim(),
        timestamp: Number(item.timestamp) || Date.now()
    };
}

function rebuildGroups() {
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

    state.groups = Array.from(map.values())
        .map((group) => {
            const marked = Boolean(findStored(state.marked, group.key));
            return {
                ...group,
                uniqueUsers: group.nicknames.size,
                marked,
                ageMs: now - group.latestAt,
                samples: group.samples.sort((a, b) => a.timestamp - b.timestamp)
            };
        })
        .map((group) => ({
            ...group,
            score: heatScore(group),
            tag: buildTag(group)
        }))
        .sort((a, b) => b.latestAt - a.latestAt);

    state.pinned = state.groups
        .filter((group) => group.ageMs <= HOT_ACTIVE_MS)
        .filter((group) => group.marked || group.count >= 2 || group.uniqueUsers >= 2)
        .sort((a, b) => b.score - a.score || b.latestAt - a.latestAt)
        .slice(0, 5);

    const pinnedKeys = new Set(state.pinned.map((group) => group.key));
    state.fresh = state.groups
        .filter((group) => !pinnedKeys.has(group.key))
        .sort((a, b) => b.latestAt - a.latestAt);
}

function heatScore(group) {
    const recency = Math.max(0, 1 - group.ageMs / HOT_ACTIVE_MS) * 18;
    const frequency = Math.min(60, group.count * 12);
    const spread = Math.min(20, group.uniqueUsers * 5);
    const marked = group.marked ? 16 : 0;
    return frequency + spread + recency + marked;
}

function normalizeContent(content) {
    return String(content)
        .replace(/\s+/g, "")
        .replace(/[!！?？。.,，~～、]+$/g, "")
        .toLowerCase();
}

function buildTag(group) {
    if (group.marked) return "已标记";
    if (group.count >= 5) return "高频";
    if (group.uniqueUsers >= 3) return "多人";
    if (group.ageMs <= 15000) return "新";
    return "热词";
}

function renderStats() {
    pinnedCount.textContent = String(state.pinned.length);
    freshCount.textContent = String(state.fresh.length);

    pinnedList.innerHTML = state.pinned.length
        ? state.pinned.map((group) => renderGroupRow(group, "pinned")).join("")
        : `<div class="empty-state compact-empty">30 秒内的高频弹幕会停留在这里</div>`;

    freshList.innerHTML = state.fresh.length
        ? state.fresh.map((group) => renderGroupRow(group, "fresh")).join("")
        : `<div class="empty-state">等待直播间弹幕进入</div>`;

    bindRowEvents(pinnedList);
    bindRowEvents(freshList);
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

function toggleMark(group) {
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
    rebuildGroups();
    renderStats();
    renderLibrary();
}

function blockGroup(group) {
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
    rebuildGroups();
    renderStats();
    renderLibrary();
}

function renderLibrary() {
    if (libraryPanel.hidden) return;
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
            const key = button.dataset.libraryRemove;
            if (state.libraryTab === "blocked") {
                state.blocked = state.blocked.filter((item) => item.key !== key);
                writeStore(blockedKey, state.blocked);
                showToast("已解除屏蔽");
            } else {
                state.marked = state.marked.filter((item) => item.key !== key);
                writeStore(markedKey, state.marked);
                showToast("已移除热梗");
            }
            rebuildGroups();
            renderStats();
            renderLibrary();
        });
    });
}

function openLibraryItem(key) {
    if (state.libraryTab !== "marked") return;
    const item = findStored(state.marked, key);
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
        tag: "已标记"
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
        context: state.raw.filter((item) => !isBlocked(item.content)).slice(-80)
    };
}

function isBlocked(content) {
    const key = normalizeContent(content);
    return state.blocked.some((item) => key === item.key || key.includes(item.key) || item.key.includes(key));
}

function findStored(list, key) {
    return list.find((item) => item.key === key);
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
