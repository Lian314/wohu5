const express = require('express');
const dns = require('dns');

// 强制 IPv4 优先，防止 Windows 系统下 Node 尝试连接 IPv6 导致的 AggregateError
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const HuyaDanmu = require('huya-danmu');

const app = express();
const PORT = 3000;

app.use(express.json());

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
    console.error("请在启动时传入房间号。例如: node server.js 660002");
    process.exit(1);
}

// 内存中保留最近的 100 条弹幕
const maxHistory = 100;
let danmakuQueue = [];

// 1. 初始化并启动虎牙弹幕拉取器
console.log(`[Huya] 正在连接虎牙直播间: ${roomID}...`);
const client = new HuyaDanmu(roomID);

client.on('connect', () => {
    console.log(`[Huya] 成功连接至直播间 ${roomID} 弹幕服务器！`);
});

client.on('message', (msg) => {
    if (msg.type === 'chat') {
        const item = {
            nickname: msg.from.name,
            content: msg.content,
            timestamp: msg.time
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

// 2. 简易 HTTP API：返回当前缓存的所有弹幕
app.get('/api/danmaku', (req, res) => {
    res.json(danmakuQueue);
});

// 3. 启动监听
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` 虎牙弹幕抓取 API 服务已成功启动！`);
    console.log(` 弹幕数据 API 地址: http://localhost:${PORT}/api/danmaku`);
    console.log(`=======================================================`);
});
