const express = require('express');
const dns = require('dns');
const path = require('path');
const { createMemeRagStore, createMemeRagRouter, renderMemeRagAdminPage } = require('./app/shared/meme-rag');

// 强制 IPv4 优先，防止 Windows 系统下 Node 尝试连接 IPv6 导致的 AggregateError
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const HuyaDanmu = require('huya-danmu');

const app = express();
const PORT = 3000;
const memeRagStore = createMemeRagStore({
    dbPath: path.join(__dirname, 'data', 'meme-rag-db.json')
});

app.use(express.json({ limit: '20mb' }));

// 跨域支持 (CORS)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const roomID = process.argv[2];
if (!roomID) {
    console.log("未传入房间号，将只启动热梗 RAG 后台。如需弹幕抓取：node server.js 660002");
}

// 内存中保留最近的 100 条弹幕
const maxHistory = 100;
let danmakuQueue = [];

let client = null;

if (roomID) {
    // 1. 初始化并启动虎牙弹幕拉取器
    console.log(`[Huya] 正在连接虎牙直播间: ${roomID}...`);
    client = new HuyaDanmu(roomID);

    client.on('connect', () => {
        console.log(`[Huya] 成功连接至直播间 ${roomID} 弹幕服务器！`);
    });

    client.on('message', (msg) => {
        if (msg.type === 'chat') {
            const receivedAt = Date.now();
            const item = {
                nickname: msg.from && msg.from.name ? msg.from.name : '虎牙用户',
                content: msg.content,
                timestamp: receivedAt,
                sourceTimestamp: normalizeDanmakuTimestamp(msg.time, receivedAt)
            };
            
            // 压入队列
            danmakuQueue.push(item);
            
            // 限制队列长度
            if (danmakuQueue.length > maxHistory) {
                danmakuQueue.shift();
            }

            console.log(`[弹幕] ${item.nickname}: ${item.content} (${new Date(item.timestamp).toLocaleTimeString()})`);
        }
    });
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

if (client) {
    client.on('error', (err) => {
        console.error(`[Huya] 抓取器发生错误:`, err.message || err);
    });

    client.on('close', (code, reason) => {
        console.log(`[Huya] 弹幕连接已关闭。代码: ${code}, 原因: ${reason}`);
        console.log("[Huya] 5秒后尝试重连...");
        setTimeout(() => {
            client.start();
        }, 5000);
    });

    client.start();
}

// 2. 简易 HTTP API：返回当前缓存的所有弹幕
app.get('/api/danmaku', (req, res) => {
    res.json(danmakuQueue);
});

app.use('/api/meme-rag', createMemeRagRouter({
    store: memeRagStore,
    parseMemeText: parseSimpleMemeText
}));

app.get('/rag', (_req, res) => {
    res.type('html').send(renderMemeRagAdminPage());
});

// 3. 启动监听
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` 虎牙弹幕抓取 API 服务已成功启动！`);
    console.log(` 弹幕数据 API 地址: http://localhost:${PORT}/api/danmaku`);
    console.log(` 热梗 RAG 后台: http://localhost:${PORT}/rag`);
    console.log(`=======================================================`);
});

async function parseSimpleMemeText(payload) {
    const text = [
        String(payload.text || ''),
        decodeUploadedText(payload)
    ].filter(Boolean).join('\n');
    const lines = text.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line.length <= 120)
        .slice(0, 80);
    const seen = new Set();
    const memes = lines.map((line) => {
        const parts = line.split(/[：:|-]/).map((part) => part.trim()).filter(Boolean);
        const content = (parts[0] || line).slice(0, 24);
        if (!content || seen.has(content)) return null;
        seen.add(content);
        return {
            content,
            aliases: [],
            description: parts.slice(1).join('，').slice(0, 180) || `从导入文档中解析出的热梗候选：“${content}”。`,
            tags: ['导入'],
            createdAt: Date.now()
        };
    }).filter(Boolean);
    return { memes };
}

function decodeUploadedText(payload) {
    const fileBase64 = String(payload.fileBase64 || '');
    const fileName = String(payload.fileName || '').toLowerCase();
    if (!fileBase64 || fileName.endsWith('.docx')) return '';
    return Buffer.from(fileBase64, 'base64').toString('utf8');
}
