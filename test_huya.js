const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const HuyaDanmu = require('huya-danmu');

// Get room ID from command line arguments, e.g., node test_huya.js 660002
// If not provided, it defaults to Uzi's room '660002'
const roomID = process.argv[2] || '660002'; 

console.log(`Connecting to Huya Room: ${roomID}...`);

const client = new HuyaDanmu(roomID);

client.on('connect', () => {
    console.log('Successfully connected to Huya danmaku server!');
});

client.on('message', msg => {
    switch (msg.type) {
        case 'chat':
            console.log(`[CHAT] [Level ${msg.from.level}] ${msg.from.name}: ${msg.content}`);
            break;
        case 'gift':
            console.log(`[GIFT] ${msg.from.name} sent ${msg.name} x ${msg.count}`);
            break;
        case 'online':
            console.log(`[ONLINE] Current online users: ${msg.count}`);
            break;
        default:
            console.log(`[OTHER] Type: ${msg.type}`, msg);
            break;
    }
});

client.on('error', err => {
    console.error('Error occurred:', err);
});

client.on('close', (code, reason) => {
    console.log(`Connection closed. Code: ${code}, Reason: ${reason}`);
});

client.start();
