const markerKey = "huya-clip-markers";
const MIN_OPACITY = 0.18;

const state = {
    payload: null,
    aiResult: null,
    aiLoading: false,
    aiError: "",
    controlSending: "",
    controlResult: null,
    opacity: 1,
    markers: readMarkers()
};

const detailBody = document.getElementById("detail-body");
const toastEl = document.getElementById("toast");
const personaActions = document.getElementById("persona-actions");

setupWindowControls();
setupPersonaControls();
setupOpacityWheel();

if (window.desktopWindow) {
    window.desktopWindow.onDetailUpdate((payload) => {
        state.payload = payload;
        state.aiResult = null;
        state.aiLoading = true;
        state.aiError = "";
        state.controlSending = "";
        state.controlResult = null;
        renderDetail();
        requestAiReview(payload);
    });
}

async function setupWindowControls() {
    const desktop = window.desktopWindow;
    if (!desktop) return;
    document.getElementById("close-window").addEventListener("click", () => desktop.close());
    const desktopState = await desktop.getState();
    state.opacity = desktopState.opacity || state.opacity;
    syncSolidFactor();
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

function setupPersonaControls() {
    personaActions.querySelectorAll("[data-persona]").forEach((button) => {
        button.addEventListener("click", () => sendPersonaDanmaku(button.dataset.persona));
    });
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

function renderDetail() {
    const payload = state.payload;
    if (!payload || !payload.group) {
        personaActions.hidden = true;
        detailBody.innerHTML = `<div class="empty-state detail-empty">点击左侧弹幕统计项查看详情</div>`;
        return;
    }

    personaActions.hidden = false;
    personaActions.querySelectorAll("[data-persona]").forEach((button) => {
        button.classList.toggle("loading", state.controlSending === button.dataset.persona);
        button.disabled = Boolean(state.controlSending);
    });

    const group = payload.group;
    const ai = state.aiResult ? normalizeAiResult(state.aiResult, payload.fallback) : null;

    detailBody.innerHTML = `
        <section class="prompter-card">
            <div class="prompter-title"><span class="section-icon">♬</span><span>一、主播提词器</span></div>
            ${renderControlResult()}
            ${renderClipTools(group)}
            ${renderPrompterBody(ai)}
            <div class="raw-list">${renderSamples(group.samples || [])}</div>
        </section>

        <section class="explain-card">
            <h2 class="detail-section-title"><span class="section-icon">▣</span><span>二、梗解释</span></h2>
            ${renderExplainBody(ai)}
        </section>
    `;

    detailBody.querySelectorAll("[data-copy-line]").forEach((button) => {
        button.addEventListener("click", () => copyText(button.dataset.copyLine));
    });
    document.getElementById("clip-button").addEventListener("click", () => addClipMarker(group));
    document.getElementById("copy-context").addEventListener("click", () => copyReviewPayload(payload.reviewPayload));
    const retry = document.getElementById("retry-ai");
    if (retry) retry.addEventListener("click", () => requestAiReview(payload));
    const login = document.getElementById("open-huya-login");
    if (login) login.addEventListener("click", () => openHuyaLogin());
}

async function sendPersonaDanmaku(persona) {
    if (!state.payload || !state.payload.group || !window.desktopWindow) return;
    state.controlSending = persona;
    state.controlResult = null;
    renderDetail();
    try {
        const result = await window.desktopWindow.sendControlDanmaku(buildControlPayload(persona));
        state.controlResult = result;
        if (result.send && result.send.ok) {
            showToast("控场弹幕已发送");
        } else if (result.send && result.send.code === "LOGIN_REQUIRED") {
            showToast("需要先登录虎牙");
        } else {
            showToast((result.send && result.send.message) || "发送未确认");
        }
    } catch (error) {
        state.controlResult = {
            text: "",
            send: {
                ok: false,
                code: "FAILED",
                message: error.message || "控场发送失败"
            }
        };
        showToast("控场发送失败");
    } finally {
        state.controlSending = "";
        renderDetail();
    }
}

function buildControlPayload(persona) {
    const payload = state.payload || {};
    const group = payload.group || {};
    const review = payload.reviewPayload || {};
    const roomProfile = review.roomProfile || {};
    return {
        persona,
        roomId: roomProfile.roomId || "",
        roomProfile,
        selectedDanmaku: review.selectedDanmaku || {
            content: group.content,
            count: group.count,
            uniqueUsers: group.uniqueUsers,
            firstTimestamp: group.firstAt,
            latestTimestamp: group.latestAt
        },
        group,
        samples: group.samples || review.samples || [],
        context: review.context || [],
        aiResult: state.aiResult
    };
}

async function requestAiReview(payload) {
    if (!payload) return;

    state.aiLoading = true;
    state.aiError = "";
    renderDetail();
    try {
        state.aiResult = await reviewDanmaku(payload);
        state.aiLoading = false;
        renderDetail();
    } catch (error) {
        state.aiResult = null;
        state.aiLoading = false;
        state.aiError = error.message || "联网搜索失败";
        renderDetail();
    }
}

async function reviewDanmaku(payload) {
    if (window.desktopWindow && window.desktopWindow.reviewDanmaku) {
        return window.desktopWindow.reviewDanmaku(payload.reviewPayload || {});
    }
    if (!payload.aiEndpoint) {
        throw new Error("AI 审核接口未配置");
    }
    const response = await fetch(payload.aiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.reviewPayload)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function normalizeAiResult(result, fallback) {
    if (!result) return fallback;
    return {
        explanation: pick(result, ["explanation", "memeExplanation", "meme.explanation", "analysis.explanation"]) || fallback.explanation,
        reason: pick(result, ["reason", "burstReason", "meme.reason", "analysis.reason"]) || fallback.reason,
        reply: pick(result, ["reply", "memeReply", "prompts.reply", "talkingPoints.reply"]) || fallback.reply,
        interaction: pick(result, ["interaction", "prompts.interaction", "talkingPoints.interaction"]) || fallback.interaction,
        cooldown: pick(result, ["cooldown", "prompts.cooldown", "talkingPoints.cooldown"]) || fallback.cooldown,
        searchEvidence: normalizeEvidence(result.searchEvidence || result.evidence || result.sources || [])
    };
}

function renderPrompterBody(ai) {
    if (state.aiLoading) {
        return `
            ${renderLoadingLine("接梗", "正在联网识别梗和场景，稍等一下就能直接念。")}
            ${renderLoadingLine("爆了", "正在压缩成一两句有节目效果的口播。")}
            ${renderLoadingLine("降温", "正在判断要不要控场。")}
        `;
    }
    if (state.aiError) {
        return `
            <div class="evidence-card loading-card">
                <span class="evidence-title">联网搜索超时</span>
                <p>当前搜索接口响应较慢，先不要采用静态模板。</p>
                <button class="secondary-button" id="retry-ai" type="button">重新识别</button>
            </div>
        `;
    }
    return `
        ${renderLine("接梗", ai.reply, "☺")}
        ${renderLine("爆了", ai.interaction, "♟")}
        ${renderLine("降温", ai.cooldown, "🛡")}
    `;
}

function renderControlResult() {
    if (state.controlSending) {
        return `
            <div class="control-send-card">
                <span>正在生成并发送控场弹幕</span>
                <p>人格：${escapeHtml(personaLabel(state.controlSending))}</p>
            </div>
        `;
    }
    const result = state.controlResult;
    if (!result) return "";
    const send = result.send || {};
    const ok = Boolean(send.ok);
    const needsLogin = send.code === "LOGIN_REQUIRED";
    return `
        <div class="control-send-card ${ok ? "sent" : "warn"}">
            <span>${ok ? "已发送" : needsLogin ? "需要登录虎牙" : "发送未确认"}</span>
            <p>${escapeHtml(result.text || send.text || "")}</p>
            <small>${escapeHtml(send.message || result.reason || "")}</small>
            <div class="control-send-actions">
                ${needsLogin ? `<button class="secondary-button" id="open-huya-login" type="button">登录虎牙</button>` : ""}
                ${result.text ? `<button class="secondary-button" data-copy-line="${escapeAttr(result.text)}" type="button">复制弹幕</button>` : ""}
            </div>
        </div>
    `;
}

function personaLabel(value) {
    const labels = {
        gentle: "温柔和蔼",
        funny: "幽默诙谐乐子人",
        justice: "激进正义感爆棚"
    };
    return labels[value] || "控场";
}

function renderExplainBody(ai) {
    if (state.aiLoading) {
        return `
            <div class="loading-block">
                <span></span><span></span><span></span>
            </div>
            <p class="copy-block muted-copy">正在联网搜索这个弹幕的梗来源、语境和风险点。</p>
        `;
    }
    if (state.aiError) {
        return `<p class="copy-block muted-copy">还没有拿到可靠搜索结果，点击上方“重新识别”再试一次。</p>`;
    }
    return `
        <p class="copy-block"><strong>梗含义：</strong>${escapeHtml(ai.explanation)}</p>
        <p class="copy-block"><strong>爆发原因：</strong>${escapeHtml(ai.reason)}</p>
        ${renderEvidence(ai.searchEvidence)}
    `;
}

function renderClipTools(group) {
    const related = state.markers.filter((item) => item.groupKey === group.key).slice(0, 3);
    return `
        <div class="clip-panel">
            <div>
                <span class="clip-label">切片打点</span>
                <p>绑定当前弹幕首次时间 ${formatClock(group.firstAt)}</p>
            </div>
            <div class="clip-actions">
                <button class="primary-button" id="clip-button">打点 ${formatClock(group.firstAt)}</button>
                <button class="secondary-button" id="copy-context">复制上下文</button>
            </div>
            ${related.length ? `
                <div class="marker-list">
                    ${related.map((item) => `<span>已记录 ${formatClock(item.timestamp)} · ${escapeHtml(item.content)}</span>`).join("")}
                </div>
            ` : `<div class="marker-list"><span>点击后会在这里留下打点记录。</span></div>`}
        </div>
    `;
}

function renderEvidence(items) {
    if (!items || !items.length) {
        return `
            <div class="evidence-card">
                <span class="evidence-title">联网搜索依据</span>
                <p>未找到可靠搜索依据，话术将采用低风险通用回应。</p>
            </div>
        `;
    }
    return `
        <div class="evidence-card">
            <span class="evidence-title">联网搜索依据</span>
            ${items.map((item, index) => `
                <p><strong>依据${index + 1}：</strong>${escapeHtml(item.summary || item.title || "")}${item.relevance ? `｜${escapeHtml(item.relevance)}` : ""}</p>
            `).join("")}
        </div>
    `;
}

function renderLoadingLine(title, text) {
    return `
        <div class="line-card loading-line">
            <span class="line-icon">·</span>
            <div class="line-text">
                <strong>${escapeHtml(title)}</strong>
                <p>${escapeHtml(text)}</p>
            </div>
            <span class="loading-dot"></span>
        </div>
    `;
}

function renderLine(title, text, icon) {
    return `
        <div class="line-card">
            <span class="line-icon">${escapeHtml(icon)}</span>
            <div class="line-text">
                <p>${escapeHtml(text)}</p>
                <strong>${escapeHtml(title)}</strong>
            </div>
            <button class="copy-button" data-copy-line="${escapeAttr(text)}">复制</button>
        </div>
    `;
}

function normalizeEvidence(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 3).map((item) => ({
        title: String(item.title || ""),
        summary: String(item.summary || item.text || item.snippet || ""),
        relevance: String(item.relevance || "")
    })).filter((item) => item.title || item.summary || item.relevance);
}

function renderSamples(samples) {
    return samples.slice(-4).reverse().map((item) => `
        <div class="raw-item">
            <span class="raw-name">${escapeHtml(item.nickname)}</span>
            <span class="raw-content">${escapeHtml(item.content)}</span>
            <span class="raw-time">${formatClock(item.timestamp)}</span>
        </div>
    `).join("");
}

function addClipMarker(group) {
    const marker = {
        id: `${group.key}-${group.firstAt}-${Date.now()}`,
        groupKey: group.key,
        content: group.content,
        timestamp: group.firstAt,
        createdAt: Date.now()
    };
    state.markers.unshift(marker);
    state.markers = state.markers.slice(0, 50);
    localStorage.setItem(markerKey, JSON.stringify(state.markers));
    showToast(`已打点 ${formatClock(group.firstAt)}`);
    renderDetail();
}

async function copyReviewPayload(payload) {
    await copyText(JSON.stringify(payload, null, 2));
}

async function copyText(text) {
    try {
        if (window.desktopWindow && window.desktopWindow.copyText) {
            await window.desktopWindow.copyText(text);
        } else {
            await navigator.clipboard.writeText(text);
        }
        showToast("已复制");
    } catch (error) {
        showToast("复制失败");
    }
}

async function openHuyaLogin() {
    if (!window.desktopWindow || !window.desktopWindow.openHuyaLogin) return;
    await window.desktopWindow.openHuyaLogin();
    showToast("请在弹出的窗口登录虎牙");
}

function readMarkers() {
    try {
        const value = JSON.parse(localStorage.getItem(markerKey) || "[]");
        return Array.isArray(value) ? value : [];
    } catch (error) {
        return [];
    }
}

function pick(source, paths) {
    for (const path of paths) {
        const value = path.split(".").reduce((target, key) => target && target[key], source);
        if (value) return Array.isArray(value) ? value.join(" / ") : String(value);
    }
    return "";
}

function formatClock(timestamp) {
    if (!timestamp) return "--:--";
    const date = new Date(timestamp);
    return `${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
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
