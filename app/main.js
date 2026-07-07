const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron');
const express = require('express');
const dns = require('dns');
const HuyaDanmu = require('huya-danmu');

if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const APP_NAME = '弹幕梗捕手';
const windows = new Set();
const ASSET_DIR = path.join(__dirname, 'renderer', 'assets');
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
let tray;
let isQuitting = false;
let isAlwaysOnTop = true;
let lastDetailPayload = null;
let apiServer;
let huyaClient;
let reconnectTimer;
let currentRoomId = '';
let backendStatus = '未连接';
let danmakuQueue = [];
let currentRoomProfile = null;

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), 'HuyaDanmakuCopilot'));
if (process.platform === 'win32') {
    app.setAppUserModelId('com.huya.danmaku.copilot');
}

function assetPath(name) {
    return path.join(ASSET_DIR, name);
}

function existingAsset(...names) {
    for (const name of names) {
        const fullPath = assetPath(name);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    return assetPath(names[0]);
}

function getAppIconPath() {
    if (process.platform === 'win32') return existingAsset('icon.ico', 'icon.png');
    if (process.platform === 'darwin') return existingAsset('icon.icns', 'icon.png');
    return existingAsset('icon.png');
}

function getTrayIcon() {
    const iconPath = process.platform === 'darwin'
        ? existingAsset('trayTemplate.png', 'tray.png', 'icon.png')
        : existingAsset('tray.png', 'icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
        image = nativeImage.createFromPath(getAppIconPath());
    }
    if (process.platform === 'darwin') {
        image = image.resize({ width: 18, height: 18 });
        image.setTemplateImage(true);
    } else {
        image = image.resize({ width: 20, height: 20 });
    }
    return image;
}

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
            count: danmakuQueue.length,
            roomProfile: currentRoomProfile
        });
    });

    api.get('/api/room-profile', async (_req, res) => {
        try {
            if (!currentRoomProfile && currentRoomId) {
                currentRoomProfile = await fetchHuyaRoomProfile(currentRoomId);
            }
            res.json(currentRoomProfile || buildEmptyRoomProfile(currentRoomId));
        } catch (error) {
            res.status(502).json({
                ...buildEmptyRoomProfile(currentRoomId),
                error: error.message || '直播间信息获取失败'
            });
        }
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
        updateTrayMenu();
    });
}

async function reviewDanmakuWithAi(payload) {
    payload = await enrichReviewPayload(payload || {});
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

async function enrichReviewPayload(payload) {
    if (!payload.roomProfile && currentRoomId) {
        if (!currentRoomProfile || Date.now() - (currentRoomProfile.updatedAt || 0) > 120000) {
            try {
                currentRoomProfile = await fetchHuyaRoomProfile(currentRoomId);
            } catch (error) {
                currentRoomProfile = currentRoomProfile || buildEmptyRoomProfile(currentRoomId);
            }
        }
        return { ...payload, roomProfile: currentRoomProfile };
    }
    return payload;
}

function buildAiCacheKey(payload) {
    const selected = payload && payload.selectedDanmaku ? payload.selectedDanmaku : {};
    const profile = payload && payload.roomProfile ? payload.roomProfile : {};
    return [
        profile.roomId || currentRoomId || '',
        profile.anchorName || '',
        profile.title || '',
        profile.category || '',
        String(selected.content || '').trim().toLowerCase()
    ].join('|').slice(0, 220);
}

function buildAiReviewPrompt(payload) {
    const selected = payload.selectedDanmaku || {};
    const samples = Array.isArray(payload.samples) ? payload.samples.slice(-6) : [];
    const context = Array.isArray(payload.context) ? payload.context.slice(-12) : [];
    const roomProfile = payload.roomProfile || buildEmptyRoomProfile(currentRoomId);
    return [
        '你是直播场控助手。以联网搜索到的热梗/事件/人物/游戏语境为主，直播间信息只做辅助消歧和补充，不要因为直播标题就强行改写梗来源。',
        '规则：',
        '1. 只输出 JSON，不要 Markdown，不要思考过程。',
        '2. 必须联网搜索；搜不到可靠内容就写“未找到可靠搜索依据”。',
        '3. 判断优先级：联网搜索事实 > 弹幕原文 > 直播间信息。直播间信息只用于判断“这个梗在当前场景怎么接”，不能覆盖搜索到的主流含义。',
        '4. 必须先搜索弹幕原文原句；如果原句已有广泛固定来源，必须采用固定来源，即使直播间分区不同。直播间信息只能影响 reply/interaction 的接法。',
        '5. 只有当弹幕原文搜索结果完全模糊或没有固定来源时，才允许用主播名/分区/标题关键词辅助判断。',
        '6. reply/interaction/cooldown 都必须把 searchEvidence 的具体信息自然融入话术，但不要出现“依据1/依据2/根据依据”这些字。',
        '7. reply 要像主播临场接梗：短、有梗、能笑一下。',
        '8. interaction 是“爆了”口播：可以口无遮拦、夸张、带节奏、很有节目效果，但不能人身攻击、歧视、色情、辱骂真实个人；像直播间炸场用语，不要温吞，不要只说“扣个1/扣个6”。',
        '9. cooldown 是降温：稳住节奏，别扩大冲突。',
        '10. 不要 AI 味，不要“这种/当年/直接扣/咱们继续/精彩还在后头”等模板腔，不要叫“宝宝/用户/河生宝宝”。',
        '11. 每条话术 1-2 句、32-62 个中文字符，可以直接照读。',
        '12. explanation 写 3-5 句：先说明搜索到的主流梗来源，再补一句当前直播间可怎么接；reason 写 1-2 句；searchEvidence 最多 3 条。',
        '13. 字段固定：explanation, reason, reply, interaction, cooldown, searchEvidence。',
        '',
        `直播间信息：${JSON.stringify(roomProfile)}`,
        `选中弹幕：${JSON.stringify(selected)}`,
        `近期样本：${JSON.stringify(samples)}`,
        `直播间上下文：${JSON.stringify(context)}`,
        '',
        '输出示例：{"explanation":"这是某梗的含义和来源。它通常出现在某个名场面被观众重新刷起时，用来快速制造共同记忆。当前直播间只影响接法，不改变梗本身来源。","reason":"弹幕集中重复，说明有人在带这个梗，适合轻轻接一下。","reply":"这句一出来味儿就对了，懂的已经在笑了。","interaction":"弹幕别装死，这波都能刷出来？懂的把屏幕打穿，今晚节目效果有了。","cooldown":"玩梗可以，别往人身上带，点到为止。","searchEvidence":[{"title":"来源","summary":"搜索事实摘要","relevance":"和弹幕的关系"}]}'
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
            max_output_tokens: 900
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
            max_tokens: 900
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
        ? parsed.searchEvidence.slice(0, 3).map((item, index) => ({
            title: String(item.title || `搜索依据${index + 1}`),
            summary: String(item.summary || ''),
            relevance: String(item.relevance || '')
        })).filter((item) => item.summary || item.relevance)
        : [];
    return {
        explanation: polishExplain(enrichExplanation(String(parsed.explanation || '未找到可靠搜索依据。'), evidence)),
        reason: polishExplain(String(parsed.reason || '本次 AI 没有返回明确爆发原因。')),
        reply: polishLine(removeEvidenceLabel(String(parsed.reply || '')), evidence, '这句有画面了，懂的已经在笑了。'),
        interaction: polishHypeLine(removeEvidenceLabel(String(parsed.interaction || '')), evidence),
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

function polishHypeLine(text, evidence) {
    const fallback = '弹幕别装死，这波都能刷出来？懂的把屏幕打穿，今晚节目效果有了。';
    const base = polishLine(text, evidence, fallback)
        .replace(/宝宝|用户|河生宝宝/g, '大家')
        .replace(/傻[逼比]|脑残|死全家|滚|废物/g, '')
        .trim();
    const tooSoft = base.length < 24 || /扣个|老粉浓度|刷起来|跟着氛围|继续|懂的已经笑了|公屏/.test(base);
    if (!tooSoft) return base;
    return fallback;
}

function enrichExplanation(text, evidence) {
    const base = String(text || '').trim();
    if (base.length >= 120 || !evidence.length) return base;
    const extra = evidence
        .map((item) => item.summary || item.relevance)
        .filter(Boolean)
        .join(' ');
    if (!extra) return base;
    return `${base.replace(/[。！？!?]?$/, '。')}${extra}`;
}

function polishExplain(text) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    const limit = 320;
    if (source.length <= limit) return source;
    return `${source.slice(0, limit).replace(/[，。！？、；：,.!?;:]?$/, '')}。`;
}

async function refreshRoomProfile(roomId) {
    try {
        currentRoomProfile = await fetchHuyaRoomProfile(roomId);
        statsWindow && statsWindow.webContents.send('backend:status', getBackendState());
        updateTrayMenu();
    } catch (error) {
        currentRoomProfile = currentRoomProfile || buildEmptyRoomProfile(roomId);
    }
}

async function fetchHuyaRoomProfile(roomId) {
    const normalized = String(roomId || '').trim();
    if (!normalized) return buildEmptyRoomProfile('');

    const response = await fetch(`https://www.huya.com/${encodeURIComponent(normalized)}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            Referer: 'https://www.huya.com/'
        },
        signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
    });
    if (!response.ok) {
        throw new Error(`Huya HTTP ${response.status}`);
    }

    const html = await response.text();
    const roomData = extractJsonVar(html, 'TT_ROOM_DATA') || {};
    const profile = extractJsonVar(html, 'TT_PROFILE_INFO') || {};
    const streamInfo = extractFirstJsonObject(html, '"gameLiveInfo"') || {};
    const liveInfo = streamInfo.gameLiveInfo || {};

    const title = firstText(
        roomData.introduction,
        liveInfo.introduction,
        liveInfo.roomName,
        extractQuotedField(html, 'introduction'),
        extractQuotedField(html, 'roomName')
    );
    const category = firstText(
        roomData.gameFullName,
        liveInfo.gameFullName,
        extractQuotedField(html, 'gameFullName')
    );
    const anchorName = firstText(
        profile.nick,
        liveInfo.nick,
        extractQuotedField(html, 'nick')
    );
    const announcement = firstText(
        liveInfo.contentIntro,
        extractQuotedField(html, 'contentIntro')
    );

    return {
        roomId: normalized,
        anchorName,
        title,
        category,
        announcement,
        liveStatus: roomData.isOn ? '直播中' : (roomData.isOff ? '未开播' : '未知'),
        popularity: Number(roomData.totalCount || liveInfo.totalCount || liveInfo.attendeeCount || 0),
        startTime: Number(roomData.startTime || liveInfo.startTime || 0),
        profileRoom: Number(roomData.profileRoom || profile.profileRoom || liveInfo.profileRoom || normalized),
        anchorHost: firstText(profile.host, profile.yyid, liveInfo.yyid, roomData.privateHost),
        updatedAt: Date.now()
    };
}

function buildEmptyRoomProfile(roomId) {
    return {
        roomId: String(roomId || ''),
        anchorName: '',
        title: '',
        category: '',
        announcement: '',
        liveStatus: '未知',
        popularity: 0,
        startTime: 0,
        profileRoom: Number(roomId) || 0,
        anchorHost: '',
        updatedAt: Date.now()
    };
}

function extractJsonVar(html, name) {
    const pattern = new RegExp(`var\\s+${name}\\s*=\\s*(\\{[\\s\\S]*?\\});`);
    const match = String(html || '').match(pattern);
    if (!match) return null;
    try {
        return JSON.parse(match[1]);
    } catch (error) {
        return null;
    }
}

function extractFirstJsonObject(html, marker) {
    const text = String(html || '');
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = text.lastIndexOf('{', markerIndex);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, index + 1));
                } catch (error) {
                    return null;
                }
            }
        }
    }
    return null;
}

function extractQuotedField(html, key) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"])*)"`);
    const match = String(html || '').match(pattern);
    if (!match) return '';
    try {
        return JSON.parse(`"${match[1]}"`);
    } catch (error) {
        return match[1];
    }
}

function firstText(...values) {
    for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
    }
    return '';
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
    currentRoomProfile = buildEmptyRoomProfile(normalized);
    refreshRoomProfile(normalized);
    updateTrayMenu();

    huyaClient = new HuyaDanmu(normalized);

    huyaClient.on('connect', () => {
        backendStatus = '进行中';
        statsWindow && statsWindow.webContents.send('backend:status', getBackendState());
        updateTrayMenu();
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
        updateTrayMenu();
    });

    huyaClient.on('close', () => {
        backendStatus = '重连中';
        statsWindow && statsWindow.webContents.send('backend:status', getBackendState());
        updateTrayMenu();
        reconnectTimer = setTimeout(() => {
            if (currentRoomId === normalized && huyaClient) {
                try {
                    huyaClient.start();
                } catch (error) {
                    backendStatus = '重连失败';
                    updateTrayMenu();
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
        count: danmakuQueue.length,
        roomProfile: currentRoomProfile
    };
}

function createTray() {
    if (tray) return;

    tray = new Tray(getTrayIcon());
    tray.setToolTip(APP_NAME);
    tray.on('click', () => {
        updateTrayMenu();
        if (process.platform === 'darwin') {
            tray.popUpContextMenu();
            return;
        }
        toggleStatsWindow();
    });
    tray.on('double-click', showStatsWindow);
    tray.on('right-click', updateTrayMenu);
    updateTrayMenu();
}

function updateTrayMenu() {
    if (!tray) return;

    const statsVisible = Boolean(statsWindow && !statsWindow.isDestroyed() && statsWindow.isVisible());
    const detailVisible = Boolean(detailWindow && !detailWindow.isDestroyed() && detailWindow.isVisible());
    const petVisible = Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());
    const stateLine = currentRoomId ? `${currentRoomId} · ${backendStatus}` : backendStatus;

    const menu = Menu.buildFromTemplate([
        {
            label: statsVisible ? '隐藏弹幕总览' : '打开弹幕总览',
            click: () => toggleStatsWindow()
        },
        {
            label: detailVisible ? '隐藏场控助手' : '显示场控助手',
            enabled: Boolean(lastDetailPayload),
            click: () => {
                if (lastDetailPayload) createDetailWindow(lastDetailPayload);
            }
        },
        {
            label: petVisible ? '隐藏桌宠' : '显示桌宠',
            click: () => setPetVisible(!petVisible)
        },
        { type: 'separator' },
        {
            label: '窗口置顶',
            type: 'checkbox',
            checked: isAlwaysOnTop,
            click: () => setAlwaysOnTop(!isAlwaysOnTop)
        },
        {
            label: `连接状态：${stateLine}`,
            enabled: false
        },
        { type: 'separator' },
        {
            label: `退出${APP_NAME}`,
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(menu);
}

function showStatsWindow() {
    if (!statsWindow || statsWindow.isDestroyed()) {
        createStatsWindow();
    } else {
        statsWindow.show();
        statsWindow.focus();
    }
    updateTrayMenu();
}

function toggleStatsWindow() {
    if (!statsWindow || statsWindow.isDestroyed()) {
        createStatsWindow();
        updateTrayMenu();
        return true;
    }

    if (statsWindow.isVisible()) {
        statsWindow.hide();
        if (detailWindow && !detailWindow.isDestroyed()) {
            detailWindow.hide();
        }
        updateTrayMenu();
        return false;
    }

    statsWindow.show();
    statsWindow.focus();
    updateTrayMenu();
    return true;
}

function setPetVisible(visible) {
    if (visible) {
        if (!petWindow || petWindow.isDestroyed()) {
            createPetWindow();
        } else {
            petWindow.show();
        }
    } else if (petWindow && !petWindow.isDestroyed()) {
        petWindow.hide();
    }
    updateTrayMenu();
}

function setAlwaysOnTop(enabled) {
    isAlwaysOnTop = Boolean(enabled);
    windows.forEach((win) => {
        if (!win.isDestroyed()) {
            win.setAlwaysOnTop(isAlwaysOnTop, isAlwaysOnTop ? 'screen-saver' : 'normal');
        }
    });
    updateTrayMenu();
    return isAlwaysOnTop;
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
        icon: getAppIconPath(),
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
    win.on('show', updateTrayMenu);
    win.on('hide', updateTrayMenu);
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
        updateTrayMenu();
    });
    statsWindow.on('close', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        statsWindow.hide();
        if (detailWindow && !detailWindow.isDestroyed()) {
            detailWindow.hide();
        }
        updateTrayMenu();
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
        updateTrayMenu();
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
        updateTrayMenu();
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
        updateTrayMenu();
    });
    detailWindow.on('close', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        detailWindow.hide();
        updateTrayMenu();
    });
    detailWindow.on('closed', () => {
        detailWindow = null;
        updateTrayMenu();
    });
}

app.whenReady().then(() => {
    startApiServer();
    if (process.platform === 'darwin' && app.dock) {
        app.dock.hide();
    }
    createTray();
    createPetWindow();
    createStatsWindow();

    app.on('activate', () => {
        showStatsWindow();
    });
});

app.on('window-all-closed', () => {
    if (isQuitting || !tray) {
        app.quit();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
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
    return setAlwaysOnTop(!isAlwaysOnTop);
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
    showStatsWindow();
    createDetailWindow(payload);
});

ipcMain.handle('stats:toggle', () => {
    return toggleStatsWindow();
});

ipcMain.handle('backend:connect-room', (_event, roomId) => connectRoom(roomId));
ipcMain.handle('backend:get-state', () => getBackendState());
