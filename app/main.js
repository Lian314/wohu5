const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const express = require('express');
const dns = require('dns');
const HuyaDanmu = require('huya-danmu');

if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const windows = new Set();
const MIN_OPACITY = 0.18;
const PET_SIZE = 132;
const AI_BASE_URL = 'https://ws-d2jrp9pxv8v3tdkq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const AI_MODEL = 'qwen3.7-plus';
const AI_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-ws-H.EMDLHYL.9skU.MEUCIQDsKktWcjuL9g_ZW7PtVBYKebiRaWQKL0l_1DL_fKIogAIgTLAlc58qVDo6IfUA4zG8UX1NfiMkrTYWU4XJoqPSxzA';
const aiReviewCache = new Map();
const AI_CACHE_MS = 10 * 60 * 1000;
let petWindow;
let statsWindow;
let detailWindow;
let isAlwaysOnTop = true;
let lastDetailPayload = null;
let apiServer;
let huyaClient;
let reconnectTimer;
let currentRoomId = '';
let backendStatus = '未连接';
let danmakuQueue = [];

app.setPath('userData', path.join(app.getPath('appData'), 'HuyaDanmakuCopilot'));

function startApiServer() {
    if (apiServer) return;

    const api = express();
    api.use(express.json());
    api.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    api.get('/api/danmaku', (_req, res) => {
        res.json(danmakuQueue);
    });

    api.get('/api/status', (_req, res) => {
        res.json({
            roomId: currentRoomId,
            status: backendStatus,
            count: danmakuQueue.length
        });
    });

    api.post('/api/danmaku-review', async (req, res) => {
        try {
            const result = await reviewDanmakuWithAi(req.body || {});
            res.json(result);
        } catch (error) {
            res.status(502).json({
                error: error.message || 'AI 审核失败',
                explanation: 'AI 联网审核暂时不可用。',
                reason: '本次没有拿到可靠的联网搜索结果，请稍后重试。',
                reply: '这条弹幕我先记一下，等确认语境后再接。',
                interaction: '大家先继续发弹幕，我看一下当前直播间的节奏。',
                cooldown: '先别急着扩散，我们确认一下再玩这个梗。',
                searchEvidence: []
            });
        }
    });

    apiServer = api.listen(3000, () => {
        backendStatus = '等待房间号';
    });
}

async function reviewDanmakuWithAi(payload) {
    const cacheKey = buildAiCacheKey(payload);
    const cached = aiReviewCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt <= AI_CACHE_MS) {
        return { ...cached.value, cached: true };
    }
    const prompt = buildAiReviewPrompt(payload);
    try {
        const content = await callBailianChat(prompt);
        const value = normalizeAiJson(content);
        aiReviewCache.set(cacheKey, { value, createdAt: Date.now() });
        return value;
    } catch (error) {
        const content = await callBailianResponses(prompt);
        const value = normalizeAiJson(content);
        aiReviewCache.set(cacheKey, { value, createdAt: Date.now() });
        return value;
    }
}

function buildAiCacheKey(payload) {
    const selected = payload && payload.selectedDanmaku ? payload.selectedDanmaku : {};
    return String(selected.content || '').trim().toLowerCase().slice(0, 80);
}

function buildAiReviewPrompt(payload) {
    const selected = payload.selectedDanmaku || {};
    const samples = Array.isArray(payload.samples) ? payload.samples.slice(-6) : [];
    const context = Array.isArray(payload.context) ? payload.context.slice(-12) : [];
    return [
        '你是直播场控助手。快速联网搜索弹幕对应的热梗/事件/人物/游戏语境，然后给主播短口播。',
        '规则：',
        '1. 只输出 JSON，不要 Markdown，不要思考过程。',
        '2. 必须联网搜索；搜不到可靠内容就写“未找到可靠搜索依据”。',
        '3. reply/interaction/cooldown 都必须把 searchEvidence 的具体信息自然融入话术，但不要出现“依据1/依据2/根据依据”这些字。',
        '4. 话术要像真人主播临场碎嘴：轻松、短促、有反应，不要 AI 味，不要“这种/当年/直接扣/咱们继续/精彩还在后头”等模板腔，不要叫“宝宝/用户/河生宝宝”。',
        '5. 每条话术 1-2 句、32-62 个中文字符，可以直接照读。',
        '6. explanation 写 2-3 句，可以多解释来源和场景；reason 写 1-2 句；searchEvidence 最多 2 条。',
        '7. 字段固定：explanation, reason, reply, interaction, cooldown, searchEvidence。',
        '',
        `选中弹幕：${JSON.stringify(selected)}`,
        `近期样本：${JSON.stringify(samples)}`,
        `直播间上下文：${JSON.stringify(context)}`,
        '',
        '输出示例：{"explanation":"这是某梗的含义和来源。它通常出现在某个名场面被观众重新刷起时，用来快速制造共同记忆。放在直播间里，更像是一句圈内暗号。","reason":"弹幕集中重复，说明有人在带这个梗，适合轻轻接一下。","reply":"这句一出来味儿就对了，懂的已经在笑了。","interaction":"懂这个梗的扣个6，我看看老粉浓度。","cooldown":"玩梗可以，别往人身上带，点到为止。","searchEvidence":[{"title":"来源","summary":"搜索事实摘要","relevance":"和弹幕的关系"}]}'
    ].join('\n');
}

async function callBailianResponses(prompt) {
    const response = await fetchWithTimeout(`${AI_BASE_URL}/responses`, {
        method: 'POST',
        headers: buildAiHeaders(),
        body: JSON.stringify({
            model: AI_MODEL,
            input: prompt,
            tools: [{ type: 'web_search' }],
            enable_thinking: false,
            temperature: 0.75,
            max_output_tokens: 650
        })
    });
    const json = await readAiResponse(response);
    const content = extractResponsesText(json);
    if (!content) {
        throw new Error('Responses API 未返回内容');
    }
    return content;
}

async function callBailianChat(prompt) {
    const response = await fetchWithTimeout(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: buildAiHeaders(),
        body: JSON.stringify({
            model: AI_MODEL,
            messages: [
                { role: 'system', content: '你是直播场控助手。必须联网搜索，不输出思考过程，只输出 JSON。' },
                { role: 'user', content: prompt }
            ],
            stream: false,
            enable_search: true,
            enable_thinking: false,
            search_options: {
                forced_search: true
            },
            response_format: { type: 'json_object' },
            temperature: 0.75,
            max_tokens: 650
        })
    });
    const json = await readAiResponse(response);
    const content = json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content || ''
        : '';
    if (!content) {
        throw new Error('Chat API 未返回内容');
    }
    return content;
}

function buildAiHeaders() {
    return {
        Authorization: `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json'
    };
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`AI HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        return response;
    } finally {
        clearTimeout(timer);
    }
}

async function readAiResponse(response) {
    const json = await response.json();
    if (json.error) {
        throw new Error(json.error.message || 'AI 返回错误');
    }
    return json;
}

function extractResponsesText(json) {
    if (typeof json.output_text === 'string') return json.output_text;
    if (Array.isArray(json.output)) {
        const parts = [];
        json.output.forEach((item) => {
            if (Array.isArray(item.content)) {
                item.content.forEach((content) => {
                    if (content && typeof content.text === 'string') parts.push(content.text);
                    if (content && typeof content.output_text === 'string') parts.push(content.output_text);
                });
            }
            if (typeof item.text === 'string') parts.push(item.text);
        });
        return parts.join('');
    }
    return '';
}

async function readChatStream(response) {
    const text = await response.text();
    return text.split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6).trim())
        .filter((line) => line && line !== '[DONE]')
        .map((line) => {
            try {
                const json = JSON.parse(line);
                return json.choices && json.choices[0] && json.choices[0].delta
                    ? json.choices[0].delta.content || ''
                    : '';
            } catch (error) {
                return '';
            }
        })
        .join('');
}

function normalizeAiJson(content) {
    const parsed = parseJsonObject(content);
    const evidence = Array.isArray(parsed.searchEvidence)
        ? parsed.searchEvidence.slice(0, 2).map((item, index) => ({
            title: String(item.title || `搜索依据${index + 1}`),
            summary: String(item.summary || ''),
            relevance: String(item.relevance || '')
        })).filter((item) => item.summary || item.relevance)
        : [];
    return {
        explanation: polishExplain(enrichExplanation(String(parsed.explanation || '未找到可靠搜索依据。'), evidence)),
        reason: polishExplain(String(parsed.reason || '本次 AI 没有返回明确爆发原因。')),
        reply: polishLine(removeEvidenceLabel(String(parsed.reply || '')), evidence, '这句有画面了，懂的已经在笑了。'),
        interaction: polishLine(removeEvidenceLabel(String(parsed.interaction || '')), evidence, '懂这个梗的扣个6，我看看老粉浓度。'),
        cooldown: polishLine(removeEvidenceLabel(String(parsed.cooldown || '')), evidence, '玩梗可以，别往人身上带，点到为止。'),
        searchEvidence: evidence,
        searchEnabled: true,
        thinkingEnabled: false,
        model: AI_MODEL
    };
}

function parseJsonObject(content) {
    const text = String(content || '').trim();
    try {
        return JSON.parse(text);
    } catch (error) {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
        throw new Error('AI 未返回可解析 JSON');
    }
}

function removeEvidenceLabel(text) {
    return String(text || '')
        .replace(/（?根据?依据\d+）?/g, '')
        .replace(/依据\d+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function polishLine(text, evidence, fallback) {
    const source = String(text || fallback)
        .replace(/宝宝|用户|河生宝宝/g, '大家')
        .replace(/这种/g, '这')
        .replace(/当年/g, '')
        .replace(/直接扣/g, '扣')
        .replace(/咱们继续/g, '继续')
        .replace(/精彩还在后头/g, '后面还有')
        .replace(/\s+/g, ' ')
        .trim();
    const enriched = source.length < 28 && evidence.length
        ? `${source.replace(/[。！!？?]?$/, '')}，懂的已经笑了。`
        : source;
    const limit = 68;
    if (enriched.length <= limit) return enriched;
    return enriched.slice(0, limit).replace(/[，。！？、；：,.!?;:]?$/, '。');
}

function enrichExplanation(text, evidence) {
    const base = String(text || '').trim();
    if (base.length >= 70 || !evidence.length) return base;
    const extra = evidence
        .map((item) => item.summary || item.relevance)
        .filter(Boolean)
        .join(' ');
    if (!extra) return base;
    return `${base.replace(/[。！？!?]?$/, '。')}${extra}`;
}

function polishExplain(text) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    const limit = 190;
    if (source.length <= limit) return source;
    return `${source.slice(0, limit).replace(/[，。！？、；：,.!?;:]?$/, '')}。`;
}

function stopHuyaClient() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (huyaClient) {
        try {
            huyaClient.close && huyaClient.close();
        } catch (error) {
            // Ignore close errors from the third-party client.
        }
        huyaClient.removeAllListeners && huyaClient.removeAllListeners();
        huyaClient = null;
    }
}

function connectRoom(roomId) {
    const normalized = String(roomId || '').trim();
    if (!/^\d{3,}$/.test(normalized)) {
        throw new Error('请输入正确的直播间号');
    }

    stopHuyaClient();
    currentRoomId = normalized;
    backendStatus = '连接中';
    danmakuQueue = [];

    huyaClient = new HuyaDanmu(normalized);

    huyaClient.on('connect', () => {
        backendStatus = '进行中';
        statsWindow && statsWindow.webContents.send('backend:status', getBackendState());
    });

    huyaClient.on('message', (msg) => {
        if (msg.type !== 'chat') return;
        const item = {
            nickname: msg.from && msg.from.name ? msg.from.name : '虎牙用户',
            content: msg.content,
            timestamp: msg.time || Date.now()
        };
        danmakuQueue.push(item);
        if (danmakuQueue.length > 150) {
            danmakuQueue.shift();
        }
    });

    huyaClient.on('error', (err) => {
        backendStatus = `错误：${err.message || err}`;
        statsWindow && statsWindow.webContents.send('backend:status', getBackendState());
    });

    huyaClient.on('close', () => {
        backendStatus = '重连中';
        statsWindow && statsWindow.webContents.send('backend:status', getBackendState());
        reconnectTimer = setTimeout(() => {
            if (currentRoomId === normalized && huyaClient) {
                try {
                    huyaClient.start();
                } catch (error) {
                    backendStatus = '重连失败';
                }
            }
        }, 5000);
    });

    huyaClient.start();
    return getBackendState();
}

function getBackendState() {
    return {
        roomId: currentRoomId,
        status: backendStatus,
        count: danmakuQueue.length
    };
}

function createWindow(options) {
    const win = new BrowserWindow({
        frame: false,
        transparent: true,
        resizable: true,
        maximizable: false,
        show: false,
        backgroundColor: '#00000000',
        alwaysOnTop: isAlwaysOnTop,
        skipTaskbar: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        ...options
    });

    windows.add(win);
    win.setAlwaysOnTop(isAlwaysOnTop, isAlwaysOnTop ? 'screen-saver' : 'normal');
    win.on('closed', () => windows.delete(win));
    return win;
}

function createStatsWindow() {
    const { workArea } = screen.getPrimaryDisplay();
    const width = 420;
    const height = 500;
    const x = workArea.x + Math.round((workArea.width - width) / 2);
    const y = workArea.y + 88;

    statsWindow = createWindow({
        width,
        height,
        minWidth: 360,
        minHeight: 420,
        x,
        y,
        title: '弹幕梗捕手'
    });

    statsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    statsWindow.once('ready-to-show', () => {
        statsWindow.show();
        statsWindow.focus();
    });
    statsWindow.on('closed', () => {
        statsWindow = null;
        if (detailWindow) {
            detailWindow.close();
        }
    });
}

function createPetWindow() {
    const { workArea } = screen.getPrimaryDisplay();
    const width = PET_SIZE;
    const height = PET_SIZE;

    petWindow = createWindow({
        width,
        height,
        minWidth: width,
        minHeight: height,
        maxWidth: width,
        maxHeight: height,
        resizable: false,
        x: workArea.x + workArea.width - width - 80,
        y: workArea.y + workArea.height - height - 92,
        title: '虎牙桌宠',
        skipTaskbar: true
    });

    petWindow.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
    petWindow.once('ready-to-show', () => {
        lockPetWindowSize();
        petWindow.show();
    });
    petWindow.setResizable(false);
    petWindow.setMinimumSize(width, height);
    petWindow.setMaximumSize(width, height);
    petWindow.on('will-resize', (event) => {
        event.preventDefault();
        lockPetWindowSize();
    });
    petWindow.on('resize', lockPetWindowSize);
    petWindow.on('resized', lockPetWindowSize);
    petWindow.on('closed', () => {
        petWindow = null;
    });
}

function lockPetWindowSize() {
    if (!petWindow || petWindow.isDestroyed()) return;
    const bounds = petWindow.getBounds();
    if (bounds.width === PET_SIZE && bounds.height === PET_SIZE) return;
    petWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: PET_SIZE,
        height: PET_SIZE
    }, false);
}

function createDetailWindow(payload) {
    lastDetailPayload = payload;

    if (detailWindow && !detailWindow.isDestroyed()) {
        detailWindow.webContents.send('detail:update', payload);
        detailWindow.show();
        detailWindow.focus();
        return;
    }

    const bounds = statsWindow ? statsWindow.getBounds() : screen.getPrimaryDisplay().workArea;
    const { workArea } = screen.getPrimaryDisplay();
    const width = bounds.width;
    const height = 430;
    const x = Math.min(Math.max(bounds.x, workArea.x + 20), workArea.x + workArea.width - width - 20);
    const y = Math.min(bounds.y + bounds.height + 10, workArea.y + workArea.height - height - 20);

    detailWindow = createWindow({
        width,
        height,
        minWidth: 360,
        minHeight: 320,
        x,
        y,
        title: '场控助手',
        parent: undefined
    });

    detailWindow.loadFile(path.join(__dirname, 'renderer', 'detail.html'));
    detailWindow.once('ready-to-show', () => {
        detailWindow.show();
        detailWindow.webContents.send('detail:update', lastDetailPayload);
        detailWindow.focus();
    });
    detailWindow.on('closed', () => {
        detailWindow = null;
    });
}

app.whenReady().then(() => {
    startApiServer();
    createPetWindow();
    createStatsWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createStatsWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

function windowFromEvent(event) {
    return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.handle('window:minimize', (event) => {
    const win = windowFromEvent(event);
    if (win) win.minimize();
});

ipcMain.handle('window:close', (event) => {
    const win = windowFromEvent(event);
    if (win) win.close();
});

ipcMain.handle('window:toggle-always-on-top', () => {
    isAlwaysOnTop = !isAlwaysOnTop;
    windows.forEach((win) => {
        if (!win.isDestroyed()) {
            win.setAlwaysOnTop(isAlwaysOnTop, isAlwaysOnTop ? 'screen-saver' : 'normal');
        }
    });
    return isAlwaysOnTop;
});

ipcMain.handle('window:get-state', (event) => {
    const win = windowFromEvent(event);
    return {
        isAlwaysOnTop,
        opacity: win ? win.getOpacity() : 1,
        bounds: win ? win.getBounds() : null
    };
});

ipcMain.handle('window:set-opacity', (event, opacity) => {
    const win = windowFromEvent(event);
    const raw = Number(opacity) || 1;
    const next = raw >= 0.985 ? 1 : Math.max(MIN_OPACITY, Math.min(1, raw));
    if (win) win.setOpacity(next);
    return next;
});

ipcMain.handle('window:set-position', (event, x, y) => {
    const win = windowFromEvent(event);
    if (win) {
        const nextX = Math.round(Number(x) || 0);
        const nextY = Math.round(Number(y) || 0);
        if (win === petWindow) {
            win.setBounds({ x: nextX, y: nextY, width: PET_SIZE, height: PET_SIZE }, false);
            return;
        }
        win.setPosition(nextX, nextY);
    }
});

ipcMain.handle('detail:open', (_event, payload) => {
    if (!statsWindow || statsWindow.isDestroyed()) {
        createStatsWindow();
    } else {
        statsWindow.show();
    }
    createDetailWindow(payload);
});

ipcMain.handle('stats:toggle', () => {
    if (!statsWindow || statsWindow.isDestroyed()) {
        createStatsWindow();
        return true;
    }

    if (statsWindow.isVisible()) {
        statsWindow.hide();
        if (detailWindow && !detailWindow.isDestroyed()) {
            detailWindow.hide();
        }
        return false;
    }

    statsWindow.show();
    statsWindow.focus();
    return true;
});

ipcMain.handle('backend:connect-room', (_event, roomId) => connectRoom(roomId));
ipcMain.handle('backend:get-state', () => getBackendState());
