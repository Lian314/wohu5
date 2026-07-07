const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, screen, session } = require('electron');
const express = require('express');
const dns = require('dns');
const HuyaDanmu = require('huya-danmu');
const { createMemeRagStore, createMemeRagRouter, renderMemeRagAdminPage } = require('./shared/meme-rag');

if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const APP_NAME = '弹幕梗捕手';
const windows = new Set();
const ASSET_DIR = path.join(__dirname, 'renderer', 'assets');
const MIN_OPACITY = 0.18;
const PET_SIZE = 132;
const HUYA_AUTH_PARTITION = 'persist:huya-auth';
const EXTERNAL_MEME_RAG_BASE_URL = (process.env.MEME_RAG_BASE_URL || 'http://localhost:3100').replace(/\/+$/, '');
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
let huyaLoginWindow;
let huyaSendWindow;
let huyaSendRoomId = '';
let lastHuyaSendAt = 0;
let currentRoomId = '';
let backendStatus = '未连接';
let danmakuQueue = [];
let currentRoomProfile = null;
let memeRagStore = null;

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), 'HuyaDanmakuCopilot'));
if (process.platform === 'win32') {
    app.setAppUserModelId('com.huya.danmaku.copilot');
}

function assetPath(name) {
    return path.join(ASSET_DIR, name);
}

function getMemeRagStore() {
    if (!memeRagStore) {
        memeRagStore = createMemeRagStore({
            dbPath: path.join(app.getPath('userData'), 'meme-rag-db.json')
        });
    }
    return memeRagStore;
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
    const ragStore = getMemeRagStore();
    api.use(express.json({ limit: '20mb' }));
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

    api.post('/api/connect-room', (req, res) => {
        try {
            const roomId = req.body && req.body.roomId ? req.body.roomId : req.query.roomId;
            res.json(connectRoom(roomId));
        } catch (error) {
            res.status(400).json({ error: error.message || '连接直播间失败' });
        }
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

    api.post('/api/control-danmaku', async (req, res) => {
        try {
            const result = await generateAndSendControlDanmaku(req.body || {});
            res.json(result);
        } catch (error) {
            res.status(502).json(normalizeControlError(error));
        }
    });

    api.post('/api/meme-library/parse', async (req, res) => {
        try {
            const result = await parseMemeLibraryText(req.body || {});
            res.json(result);
        } catch (error) {
            res.status(502).json({
                error: error.message || '热梗解析失败',
                memes: []
            });
        }
    });

    api.use('/api/meme-rag', createMemeRagRouter({
        store: ragStore,
        parseMemeText: parseMemeLibraryText
    }));

    api.get('/rag', (_req, res) => {
        res.type('html').send(renderMemeRagAdminPage());
    });

    apiServer = api.listen(3000, () => {
        backendStatus = '等待房间号';
        updateTrayMenu();
    });
    apiServer.on('error', (error) => {
        backendStatus = error && error.code === 'EADDRINUSE'
            ? '端口占用，已切换内部通道'
            : `API 错误：${error.message || error}`;
        statsWindow && statsWindow.webContents.send('backend:status', getBackendState());
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

async function requestExternalMemeRag(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 1800);
    try {
        const response = await fetch(`${EXTERNAL_MEME_RAG_BASE_URL}${pathname}`, {
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`外接热梗库 HTTP ${response.status}: ${body.slice(0, 160)}`);
        }
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

function externalMemeRagUnavailable(error) {
    return {
        external: true,
        baseUrl: EXTERNAL_MEME_RAG_BASE_URL,
        error: error.message || '外接热梗库不可用',
        code: 'EXTERNAL_RAG_UNAVAILABLE'
    };
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

async function generateAndSendControlDanmaku(payload) {
    const generated = await generateControlDanmaku(payload);
    const sendResult = await sendHuyaDanmaku(generated.text, payload.roomId || currentRoomId);
    return {
        ...generated,
        send: sendResult
    };
}

async function generateControlDanmaku(payload) {
    const persona = normalizePersona(payload.persona);
    const roomProfile = payload.roomProfile || currentRoomProfile || buildEmptyRoomProfile(currentRoomId);
    const prompt = buildControlDanmakuPrompt({
        ...payload,
        persona,
        roomProfile
    });
    const content = await callBailianChat(prompt).catch(() => callBailianResponses(prompt));
    const parsed = parseJsonObject(content);
    const text = sanitizeDanmakuText(parsed.text || parsed.danmaku || parsed.line || '');
    return {
        persona: persona.id,
        personaLabel: persona.label,
        text: text || persona.fallback,
        reason: String(parsed.reason || '已根据当前弹幕和直播间语境生成控场弹幕。').slice(0, 120),
        generatedAt: Date.now(),
        roomId: String(payload.roomId || currentRoomId || '')
    };
}

function normalizePersona(value) {
    const personas = {
        gentle: {
            id: 'gentle',
            label: '温柔和蔼',
            tone: '温柔、体面、护人但不阴阳怪气，像成熟场控帮主播把火降下来。',
            fallback: '大家轻一点，玩梗别往人身上带，给主播留点舒服空间。'
        },
        funny: {
            id: 'funny',
            label: '幽默诙谐乐子人',
            tone: '幽默、嘴快、有节目效果，用玩笑把攻击弹幕顶回去，但不辱骂真实个人。',
            fallback: '别尬黑了，这波弹幕火力太歪，节目效果留给操作别留给人身。'
        },
        justice: {
            id: 'justice',
            label: '激进正义感爆棚',
            tone: '强势、护短、正义感很足，敢把节奏顶回去，但不能脏话、人身攻击、歧视或威胁。',
            fallback: '攻击人的弹幕收一收，真有本事看操作，别躲屏幕后面带歪节奏。'
        }
    };
    return personas[value] || personas.funny;
}

function buildControlDanmakuPrompt(payload) {
    const persona = payload.persona;
    const selected = payload.selectedDanmaku || payload.group || {};
    const context = Array.isArray(payload.context) ? payload.context.slice(-30) : [];
    const samples = Array.isArray(payload.samples) ? payload.samples.slice(-12) : [];
    return [
        '你是虎牙直播间场控弹幕生成器。你的任务是生成“一条将被真实发送到直播间的弹幕”。',
        '只输出 JSON，不要 Markdown，不要思考过程。',
        `人格：${persona.label}。语气要求：${persona.tone}`,
        '目标：对抗当前弹幕里的攻击、带节奏或一边倒应援，让直播间气氛回到可控状态。',
        '硬规则：',
        '1. text 只能是一条弹幕，12-32 个中文字符，像真人发的，不要 AI 腔。',
        '2. 可以有节目效果，但不能辱骂、歧视、色情、威胁、引战现实群体。',
        '3. 电竞队伍失衡时，可以补弱势一边的应援；人身攻击时，优先护人和降温。',
        '4. 不要出现“根据上下文/作为AI/建议发送/我认为”。',
        '5. 输出字段固定：text, reason。',
        '',
        `直播间信息：${JSON.stringify(payload.roomProfile || {})}`,
        `当前弹幕：${JSON.stringify(selected)}`,
        `样本：${JSON.stringify(samples)}`,
        `近期上下文：${JSON.stringify(context)}`,
        '',
        '输出示例：{"text":"别尬黑了，节目效果看操作别看嘴硬。","reason":"攻击性弹幕开始抬头，需要用玩笑压回节奏。"}'
    ].join('\n');
}

function sanitizeDanmakuText(text) {
    return String(text || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, '')
        .slice(0, 50);
}

async function parseMemeLibraryText(payload) {
    const sourceText = [
        String(payload.text || '').trim(),
        extractUploadedDocumentText(payload)
    ].filter(Boolean).join('\n\n').trim();
    if (!sourceText) {
        return { memes: [] };
    }
    const prompt = [
        '你是直播热梗库整理助手。请从用户提供的文本或文档内容里提取适合直播场控使用的热梗。',
        '只输出 JSON，不要 Markdown，不要思考过程。',
        '每个梗包含 content, aliases, description, tags。',
        '规则：',
        '1. content 是主梗原句，2-16 字优先。',
        '2. aliases 是别名/相似说法数组，最多 6 个。',
        '3. description 用 1-2 句解释来源、含义和直播间怎么接。',
        '4. tags 最多 4 个，比如 电竞、抽象、夸夸、控场、热梗。',
        '5. 去掉纯广告、辱骂、隐私、人身攻击和不可直接使用的内容。',
        '6. 最多返回 24 条。',
        '',
        `文本：${sourceText.slice(0, 12000)}`,
        '',
        '输出示例：{"memes":[{"content":"主梗原句","aliases":["相似说法","别名"],"description":"用 1-2 句说明这个梗的来源、含义和直播间接法。","tags":["热梗","调侃"]}]}'
    ].join('\n');
    const content = await callBailianChat(prompt).catch(() => callBailianResponses(prompt));
    const parsed = parseJsonObject(content);
    const memes = Array.isArray(parsed.memes) ? parsed.memes : [];
    return {
        memes: memes.slice(0, 24).map((item) => normalizeParsedMeme(item)).filter(Boolean)
    };
}

function extractUploadedDocumentText(payload) {
    const fileName = String(payload.fileName || '').toLowerCase();
    const fileBase64 = String(payload.fileBase64 || '');
    if (!fileBase64) return '';
    const buffer = Buffer.from(fileBase64, 'base64');
    if (fileName.endsWith('.docx')) {
        return extractDocxText(buffer);
    }
    return buffer.toString('utf8');
}

function extractDocxText(buffer) {
    const entry = readZipEntry(buffer, 'word/document.xml');
    if (!entry) return '';
    return entry
        .toString('utf8')
        .replace(/<w:tab\/>/g, ' ')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function readZipEntry(buffer, wantedName) {
    const eocdOffset = findZipEocd(buffer);
    if (eocdOffset < 0) return null;
    const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
    let offset = centralOffset;
    while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        if (name === wantedName) {
            const localNameLength = buffer.readUInt16LE(localOffset + 26);
            const localExtraLength = buffer.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
            if (method === 0) return compressed;
            if (method === 8) return zlib.inflateRawSync(compressed);
            return null;
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return null;
}

function findZipEocd(buffer) {
    const min = Math.max(0, buffer.length - 0xffff - 22);
    for (let index = buffer.length - 22; index >= min; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) return index;
    }
    return -1;
}

function normalizeParsedMeme(item) {
    const content = sanitizeMemeField(item && item.content);
    if (!content) return null;
    return {
        key: normalizeKey(content),
        content,
        aliases: Array.isArray(item.aliases)
            ? item.aliases.map(sanitizeMemeField).filter(Boolean).slice(0, 6)
            : [],
        description: String(item.description || '').replace(/\s+/g, ' ').trim().slice(0, 180),
        tags: Array.isArray(item.tags)
            ? item.tags.map(sanitizeMemeField).filter(Boolean).slice(0, 4)
            : [],
        createdAt: Date.now()
    };
}

function sanitizeMemeField(value) {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>]/g, '')
        .trim()
        .slice(0, 80);
}

function normalizeKey(value) {
    return String(value || '')
        .replace(/\s+/g, '')
        .replace(/[!！?？。.,，~～、]+$/g, '')
        .toLowerCase();
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
        const receivedAt = Date.now();
        const item = {
            nickname: msg.from && msg.from.name ? msg.from.name : '虎牙用户',
            content: msg.content,
            timestamp: receivedAt,
            sourceTimestamp: normalizeDanmakuTimestamp(msg.time, receivedAt)
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

function normalizeDanmakuTimestamp(value, fallback = Date.now()) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.getTime();
    }

    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return normalizeDanmakuTimestamp(numeric, fallback);
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

function openHuyaLoginWindow() {
    if (huyaLoginWindow && !huyaLoginWindow.isDestroyed()) {
        huyaLoginWindow.show();
        huyaLoginWindow.focus();
        return { opened: true };
    }

    const roomId = String(currentRoomId || '').trim();
    huyaLoginWindow = new BrowserWindow({
        width: 980,
        height: 720,
        minWidth: 760,
        minHeight: 560,
        title: '登录虎牙账号',
        icon: getAppIconPath(),
        webPreferences: {
            partition: HUYA_AUTH_PARTITION,
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    huyaLoginWindow.loadURL(roomId ? `https://www.huya.com/${encodeURIComponent(roomId)}` : 'https://www.huya.com/');
    huyaLoginWindow.on('closed', () => {
        huyaLoginWindow = null;
    });
    return { opened: true };
}

async function sendHuyaDanmaku(text, roomId) {
    const cleanText = sanitizeDanmakuText(text);
    const normalizedRoom = String(roomId || currentRoomId || '').trim();
    if (!cleanText) {
        return { ok: false, code: 'EMPTY_TEXT', message: '弹幕内容为空' };
    }
    if (!/^\d{3,}$/.test(normalizedRoom)) {
        return { ok: false, code: 'NO_ROOM', message: '缺少直播间号' };
    }
    if (Date.now() - lastHuyaSendAt < 8000) {
        return { ok: false, code: 'RATE_LIMIT', message: '发送太快，稍等几秒再点' };
    }

    try {
        const loginState = await getHuyaAuthState();
        if (!loginState.likelyLoggedIn) {
            openHuyaLoginWindow();
            return {
                ok: false,
                code: 'LOGIN_REQUIRED',
                message: '请先在弹出的虎牙窗口登录账号，登录后再点人格按钮发送',
                text: cleanText,
                auth: loginState
            };
        }

        await ensureHuyaSendWindow(normalizedRoom);
        const result = await huyaSendWindow.webContents.executeJavaScript(buildHuyaSendScript(cleanText, normalizedRoom), true);
        if (result && result.ok) {
            lastHuyaSendAt = Date.now();
            return { ok: true, code: 'SENT', message: '已通过虎牙登录态发送', text: cleanText };
        }
        if (result && result.code === 'LOGIN_REQUIRED') {
            showHuyaSendWindow();
            return { ok: false, code: 'LOGIN_REQUIRED', message: '需要先登录虎牙账号', text: cleanText };
        }
        showHuyaSendWindow();
        return {
            ok: false,
            code: result && result.code ? result.code : 'SEND_FAILED',
            message: result && result.message ? result.message : '虎牙页面未确认真实发送，请在弹出的房间页检查登录状态',
            text: cleanText
        };
    } catch (error) {
        showHuyaSendWindow();
        return {
            ok: false,
            code: 'SEND_FAILED',
            message: error.message || '虎牙发送失败',
            text: cleanText
        };
    }
}

async function ensureHuyaSendWindow(roomId) {
    if (!huyaSendWindow || huyaSendWindow.isDestroyed()) {
        huyaSendWindow = new BrowserWindow({
            width: 960,
            height: 720,
            show: false,
            title: '虎牙弹幕发送通道',
            icon: getAppIconPath(),
            webPreferences: {
                partition: HUYA_AUTH_PARTITION,
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        huyaSendWindow.on('closed', () => {
            huyaSendWindow = null;
            huyaSendRoomId = '';
        });
    }

    if (huyaSendRoomId !== roomId || !huyaSendWindow.webContents.getURL().includes(`huya.com/${roomId}`)) {
        await huyaSendWindow.loadURL(`https://www.huya.com/${encodeURIComponent(roomId)}`);
        huyaSendRoomId = roomId;
        await waitForHuyaRoomReady(huyaSendWindow);
    }
}

function waitForHuyaRoomReady(win) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, 6000);
        win.webContents.once('did-finish-load', finish);
        win.webContents.once('did-stop-loading', finish);
    });
}

async function getHuyaAuthState() {
    try {
        const cookies = await session.fromPartition(HUYA_AUTH_PARTITION).cookies.get({ domain: 'huya.com' });
        const names = new Set(cookies.map((item) => item.name));
        const authNames = ['udb_uid', 'udb_n', 'yyuid', 'username', 'huya_uid', 'uid'];
        return {
            likelyLoggedIn: authNames.some((name) => names.has(name)),
            cookies: cookies.map((item) => item.name).filter((name) => authNames.includes(name))
        };
    } catch (error) {
        return { likelyLoggedIn: false, cookies: [] };
    }
}

function showHuyaSendWindow() {
    if (!huyaSendWindow || huyaSendWindow.isDestroyed()) return;
    huyaSendWindow.show();
    huyaSendWindow.focus();
}

function buildHuyaSendScript(text, roomId) {
    return `
(() => {
    const text = ${JSON.stringify(text)};
    const roomId = ${JSON.stringify(String(roomId || ''))};
    const url = new URL(location.href);
    if (!/huya\\.com$/i.test(url.hostname) && !/\\.huya\\.com$/i.test(url.hostname)) {
        return { ok: false, code: 'BAD_PAGE', message: '发送页面不是虎牙直播页：' + location.href };
    }
    if (roomId && !url.pathname.includes(roomId)) {
        return { ok: false, code: 'WRONG_ROOM', message: '发送页面不是当前绑定直播间：' + location.href };
    }
    const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const bodyText = document.body ? document.body.innerText || '' : '';
    const loginHints = ['登录后发弹幕', '请先登录', '登录虎牙', '登录/注册'];
    const inputSelectors = [
        '#pub_msg_input',
        '#pub_msg_input textarea',
        '#pub_msg_input input',
        '.msg-input',
        '.msg-input textarea',
        '.msg-input input',
        '.room-chat textarea',
        '.room-chat input',
        '.chat-room textarea',
        '.chat-room input',
        '.pub_msg_input',
        '.chat-input textarea',
        '.chat-input input',
        'textarea[placeholder*="弹幕"]',
        'input[placeholder*="弹幕"]',
        'textarea',
        'input[type="text"]',
        'div[contenteditable="true"]'
    ];
    const inputs = [...new Set(inputSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))];
    const input = inputs.find(visible);
    if (!input) {
        if (loginHints.some((hint) => bodyText.includes(hint))) {
            return { ok: false, code: 'LOGIN_REQUIRED', message: '页面提示需要登录后发弹幕' };
        }
        return { ok: false, code: 'INPUT_NOT_FOUND', message: '没有找到虎牙弹幕输入框' };
    }
    if (loginHints.some((hint) => bodyText.includes(hint)) && !document.cookie) {
        return { ok: false, code: 'LOGIN_REQUIRED', message: '页面提示需要登录后发弹幕' };
    }
    input.focus();
    if ('value' in input) {
        const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value');
        if (setter && setter.set) {
            setter.set.call(input, text);
        } else {
            input.value = text;
        }
    } else {
        input.textContent = text;
        input.innerText = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const before = 'value' in input ? input.value : (input.innerText || input.textContent || '');
    const ancestors = [];
    let cursor = input;
    for (let index = 0; index < 6 && cursor; index += 1) {
        ancestors.push(cursor);
        cursor = cursor.parentElement;
    }
    const sendSelectors = [
        '.send-btn',
        '.btn-send',
        '.send',
        '.pub-send',
        '.msg-send',
        'button',
        '[role="button"]'
    ];
    const candidates = [...new Set(ancestors.flatMap((root) => sendSelectors.flatMap((selector) => Array.from(root.querySelectorAll ? root.querySelectorAll(selector) : []))))]
        .filter(visible)
        .filter((el) => {
            const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
            const cls = String(el.className || '');
            return /^发送$/.test(label) || /send|submit|pub/i.test(cls);
        })
        .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (candidates[0]) {
        candidates[0].click();
    } else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
    const after = 'value' in input ? input.value : (input.innerText || input.textContent || '');
    if (after && after.trim() === before.trim()) {
        return { ok: false, code: 'NOT_CONFIRMED', message: '已尝试发送，但输入框未清空，虎牙页面没有确认发出' };
    }
    return { ok: true, code: candidates[0] ? 'CLICK_SENT' : 'ENTER_SENT', message: '虎牙输入框已清空，发送已触发' };
})()
`;
}

function normalizeControlError(error) {
    return {
        error: error.message || '控场弹幕生成失败',
        text: '',
        send: {
            ok: false,
            code: 'AI_FAILED',
            message: 'AI 生成失败，未执行发送'
        }
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
ipcMain.handle('backend:get-danmaku', () => danmakuQueue);
ipcMain.handle('backend:get-state', () => getBackendState());
ipcMain.handle('auth:open-huya-login', () => openHuyaLoginWindow());
ipcMain.handle('control:send-danmaku', (_event, payload) => generateAndSendControlDanmaku(payload || {}));
ipcMain.handle('ai:review-danmaku', (_event, payload) => reviewDanmakuWithAi(payload || {}));
ipcMain.handle('meme-library:parse', (_event, payload) => parseMemeLibraryText(payload || {}));
ipcMain.handle('meme-rag:list', async () => {
    try {
        return {
            ...(await requestExternalMemeRag('/api/meme-rag/items')),
            external: true,
            baseUrl: EXTERNAL_MEME_RAG_BASE_URL
        };
    } catch (error) {
        return {
            ...externalMemeRagUnavailable(error),
            count: 0,
            items: []
        };
    }
});
ipcMain.handle('meme-rag:match', async (_event, payload) => {
    try {
        return {
            ...(await requestExternalMemeRag('/api/meme-rag/match', {
                method: 'POST',
                body: payload || {}
            })),
            external: true,
            baseUrl: EXTERNAL_MEME_RAG_BASE_URL
        };
    } catch (error) {
        return {
            ...externalMemeRagUnavailable(error),
            matches: []
        };
    }
});
ipcMain.handle('meme-rag:upsert', async (_event, payload) => {
    try {
        return {
            ...(await requestExternalMemeRag('/api/meme-rag/bulk', {
                method: 'POST',
                body: {
                    items: Array.isArray(payload && payload.items) ? payload.items : [payload || {}],
                    source: payload && payload.source ? payload.source : 'desktop'
                }
            })),
            external: true,
            baseUrl: EXTERNAL_MEME_RAG_BASE_URL
        };
    } catch (error) {
        return externalMemeRagUnavailable(error);
    }
});
ipcMain.handle('meme-rag:remove', async (_event, key) => {
    try {
        return {
            ...(await requestExternalMemeRag(`/api/meme-rag/items/${encodeURIComponent(key)}`, {
                method: 'DELETE'
            })),
            external: true,
            baseUrl: EXTERNAL_MEME_RAG_BASE_URL
        };
    } catch (error) {
        return externalMemeRagUnavailable(error);
    }
});
ipcMain.handle('meme-rag:import', async (_event, payload) => {
    try {
        return {
            ...(await requestExternalMemeRag('/api/meme-rag/import', {
                method: 'POST',
                body: payload || {}
            })),
            external: true,
            baseUrl: EXTERNAL_MEME_RAG_BASE_URL
        };
    } catch (error) {
        return externalMemeRagUnavailable(error);
    }
});
ipcMain.handle('clipboard:write-text', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
});
