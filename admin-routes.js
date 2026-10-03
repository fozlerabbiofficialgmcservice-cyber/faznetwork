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

// মাইক্রোটিক বাইনারি প্রোটোকল ডিকোড করার পার্সার
function parseMikrotikStream(buf) {
    let offset = 0;
    const words = [];
    while (offset < buf.length) {
        let b = buf[offset++];
        let len = 0;
        if ((b & 0x80) === 0x00) {
            len = b;
        } else if ((b & 0xC0) === 0x80) {
            len = ((b & ~0xC0) << 8) | buf[offset++];
        } else if ((b & 0xE0) === 0xC0) {
            len = ((b & ~0xE0) << 16) | (buf[offset++] << 8) | buf[offset++];
        } else if ((b & 0xF0) === 0xE0) {
            len = ((b & ~0xF0) << 24) | (buf[offset++] << 16) | (buf[offset++] << 8) | buf[offset++];
        } else if ((b & 0xF8) === 0xF0) {
            len = (buf[offset++] << 24) | (buf[offset++] << 16) | (buf[offset++] << 8) | buf[offset++];
        }
        if (len === 0) {
            words.push('');
            continue;
        }
        if (offset + len > buf.length) break;
        words.push(buf.toString('utf-8', offset, offset + len));
        offset += len;
    }
    return words;
}

// কমান্ড এক্সিকিউট করে সম্পূর্ণ রেকর্ড লিস্ট সংগ্রহ
function executeQueryCommand(cmdWords) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let loggedIn = false;
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                client.destroy();
                resolve([]);
            }
        }, 7000);

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

                    // প্রোটোকল অনুযায়ী ওয়ার্ড পার্সিং
                    const words = parseMikrotikStream(buffer);
                    const results = [];
                    let currentObj = null;

                    for (const word of words) {
                        if (word === '!re') {
                            if (currentObj) results.push(currentObj);
                            currentObj = {};
                        } else if (word === '!done' || word === '!trap') {
                            if (currentObj) results.push(currentObj);
                            break;
                        } else if (word.startsWith('=')) {
                            const eqIdx = word.indexOf('=', 1);
                            if (eqIdx !== -1) {
                                const prop = word.substring(1, eqIdx);
                                const val = word.substring(eqIdx + 1);
                                if (currentObj) currentObj[prop] = val;
                            }
                        }
                    }
                    resolve(results);
                }
            }
        });

        client.on('error', (err) => {
            console.error('[ROUTER SOCKET ERROR]:', err.message);
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                client.destroy();
                resolve([]);
            }
        });
    });
}

// ১. ট্রানজেকশন তালিকা রিটার্ন
router.get('/transactions', (req, res) => {
    try {
        if (!fs.existsSync(DB_FILE)) return res.json({});
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8') || '{}');
        res.json(data);
    } catch {
        res.json({});
    }
});

// ২. PPPoE ইউজার তালিকা
router.get('/pppoe/list', async (req, res) => {
    try {
        const list = await executeQueryCommand(['/ppp/secret/print']);
        res.json(list);
    } catch {
        res.json([]);
    }
});

// ৩. নতুন PPPoE ইউজার যোগ
router.post('/pppoe/add', async (req, res) => {
    try {
        const body = req.body || {};
        const { name, password, profile, comment } = body;
        if (!name || !password) {
            return res.status(400).json({ success: false, message: 'Username and password required' });
        }
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
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ৪. PPPoE সক্রিয়/নিষ্ক্রিয় ও রিকানেক্ট
router.post('/pppoe/toggle', async (req, res) => {
    try {
        const body = req.body || {};
        const { username, disable } = body;
        if (!username) return res.status(400).json({ success: false, message: 'Username required' });

        await executeQueryCommand(['/ppp/secret/set', `=numbers=${username}`, `=disabled=${disable || 'yes'}`]);
        if (disable === 'yes') {
            await executeQueryCommand(['/ppp/active/remove', `?name=${username}`]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ৫. Hotspot ইউজার তালিকা
router.get('/hotspot/list', async (req, res) => {
    try {
        const list = await executeQueryCommand(['/user-manager/user/print']);
        res.json(list);
    } catch {
        res.json([]);
    }
});

// ৬. Hotspot ম্যানুয়াল রিনিউ
router.post('/hotspot/renew', async (req, res) => {
    try {
        const body = req.body || {};
        const { username, profile } = body;
        if (!username || !profile) return res.status(400).json({ success: false, message: 'Missing parameters' });

        await executeQueryCommand([
            '/user-manager/user-profile/add',
            `=user=${username}`,
            `=profile=${profile}`
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
