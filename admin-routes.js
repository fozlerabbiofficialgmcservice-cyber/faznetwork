const express = require('express');
const router = express.Router();
const net = require('net');
const path = require('path');
const fs = require('fs');

const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '103.54.37.182';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT) || 1126;
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'smsbot';
const MIKROTIK_PASS = process.env.MIKROTIK_PASSWORD || '66778';
const DB_FILE = path.join(__dirname, 'transactions.json');

// লেন্থ এনকোডিং
function encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xFF]);
    return Buffer.from([0xF0, (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
}

function encodeWord(word) {
    const b = Buffer.from(word, 'utf-8');
    return Buffer.concat([encodeLength(b.length), b]);
}

// মাইক্রোটিকে একাধিক ফলাফল পড়ার জন্য API এক্সিকিউটর
function executeQueryCommand(cmdWords) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let loggedIn = false;
        let finished = false;
        let responseList = [];

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                client.destroy();
                resolve(responseList);
            }
        }, 8000);

        client.connect(MIKROTIK_PORT, MIKROTIK_HOST, () => {
            const loginReq = Buffer.concat([
                encodeWord('/login'),
                encodeWord(`=name=${MIKROTIK_USER}`),
                encodeWord(`=password=${MIKROTIK_PASS}`),
                Buffer.from([0x00])
            ]);
            client.write(loginReq);
        });

        client.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const text = buffer.toString('utf-8');

            if (!loggedIn && (text.includes('!done') || text.includes('!trap'))) {
                loggedIn = true;
                buffer = Buffer.alloc(0);
                const payload = cmdWords.map(w => encodeWord(w));
                payload.push(Buffer.from([0x00]));
                client.write(Buffer.concat(payload));
            } else if (loggedIn && (text.includes('!done') || text.includes('!trap'))) {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    client.end();
                    // মাইক্রোটিক রেসপন্স পার্সিং
                    const blocks = text.split('!re');
                    blocks.shift();
                    blocks.forEach(block => {
                        let item = {};
                        block.split('\n').forEach(line => {
                            if (line.startsWith('=')) {
                                const parts = line.substring(1).split('=');
                                if (parts.length >= 2) item[parts[0]] = parts.slice(1).join('=');
                            }
                        });
                        if (Object.keys(item).length) responseList.push(item);
                    });
                    resolve(responseList);
                }
            }
        });

        client.on('error', () => {
            if (!finished) { finished = true; resolve([]); }
        });
    });
}

// ট্রানজেকশন তালিকা রিটার্ন
router.get('/transactions', (req, res) => {
    try {
        if (!fs.existsSync(DB_FILE)) return res.json({});
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8') || '{}');
        res.json(data);
    } catch {
        res.json({});
    }
});

// PPPoE ইউজার তালিকা
router.get('/pppoe/list', async (req, res) => {
    const list = await executeQueryCommand(['/ppp/secret/print']);
    res.json(list);
});

// নতুন PPPoE ইউজার যোগ
router.post('/pppoe/add', async (req, res) => {
    const { name, password, profile, comment } = req.body;
    const cmd = [
        '/ppp/secret/add',
        `=name=${name}`,
        `=password=${password}`,
        `=profile=${profile || 'default'}`,
        `=service=pppoe`
    ];
    if (comment) cmd.push(`=comment=${comment}`);
    await executeQueryCommand(cmd);
    res.json({ success: true });
});

// PPPoE সক্রিয়/নিষ্ক্রিয় ও রিকানেক্ট
router.post('/pppoe/toggle', async (req, res) => {
    const { username, disable } = req.body;
    await executeQueryCommand(['/ppp/secret/set', `=numbers=${username}`, `=disabled=${disable}`]);
    if (disable === 'yes') {
        // একটিভ সেশন কেটে দেওয়া
        await executeQueryCommand(['/ppp/active/remove', `?name=${username}`]);
    }
    res.json({ success: true });
});

// Hotspot ইউজার তালিকা
router.get('/hotspot/list', async (req, res) => {
    const list = await executeQueryCommand(['/user-manager/user/print']);
    res.json(list);
});

// Hotspot ম্যানুয়াল রিনিউ
router.post('/hotspot/renew', async (req, res) => {
    const { username, profile } = req.body;
    await executeQueryCommand([
        '/user-manager/user-profile/add',
        `=user=${username}`,
        `=profile=${profile}`
    ]);
    res.json({ success: true });
});

module.exports = router;
