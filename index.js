const express = require('express');
const net = require('net');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

process.on('uncaughtException', function (err) {
    console.error('[UNCAUGHT EXCEPTION SAFEGUARD]:', err.message);
});

process.on('unhandledRejection', function (reason) {
    console.error('[UNHANDLED REJECTION SAFEGUARD]:', reason);
});

const app = express();
const PORT = process.env.PORT || 10000;

app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// রেট লিমিটার
const requestTracker = {};
function rateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (!requestTracker[ip]) {
        requestTracker[ip] = { count: 1, resetTime: now + 60000 };
    } else {
        if (now > requestTracker[ip].resetTime) {
            requestTracker[ip] = { count: 1, resetTime: now + 60000 };
        } else {
            requestTracker[ip].count++;
            if (requestTracker[ip].count > 10) {
                return res.status(429).json({
                    success: false,
                    message: 'অতিরিক্ত চেষ্টা করা হয়েছে। অনুগ্রহ করে ১ মিনিট পর আবার চেষ্টা করুন।'
                });
            }
        }
    }
    next();
}

// মাইক্রোটিক কনফিগ
const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '103.54.37.182';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT, 10) || 1126;
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'smsbot';
const MIKROTIK_PASS = process.env.MIKROTIK_PASSWORD || '66778';

// FAZ SMS Gateway
const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'http://10.71.0.7:8080/send-sms';
const SMS_GATEWAY_TOKEN = process.env.SMS_GATEWAY_TOKEN || 'Bearer faz_secure_token_2026';

// ফাইল স্টোরেজ
const DB_FILE = path.join(__dirname, 'transactions.json');
const CUSTOMERS_FILE = path.join(__dirname, 'customers.json');

const PRICE_PROFILE_MAP = {
    '10': 'Profile-1Hour',
    '15': 'Profile-12Hour',
    '20': 'Profile-1Day',
    '40': 'Profile-3Day',
    '60': 'Profile-7Day',
    '90': 'Profile-15Day',
    '150': 'Profile-30Day',
    '200': 'Profile-100GB',
    '350': 'Profile-300GB'
};

function loadJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) return {};
        const content = fs.readFileSync(filePath, 'utf-8');
        return content ? JSON.parse(content) : {};
    } catch (e) {
        return {};
    }
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error saving ' + filePath + ':', e.message);
    }
}

// =================== MikroTik Binary Socket API ===================
function encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xFF]);
    if (len < 0x200000) return Buffer.from([(len >> 16) | 0xC0, (len >> 8) & 0xFF, len & 0xFF]);
    if (len < 0x10000000) return Buffer.from([(len >> 24) | 0xE0, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
    return Buffer.from([0xF0, (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
}

function encodeWord(word) {
    const b = Buffer.from(word, 'utf-8');
    return Buffer.concat([encodeLength(b.length), b]);
}

function executeSingleCommand(cmdWords) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let loggedIn = false;
        let finished = false;
        const results = [];

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                client.destroy();
                resolve(results);
            }
        }, 8000);

        client.connect(MIKROTIK_PORT, MIKROTIK_HOST, () => {
            const loginReq = Buffer.concat([
                encodeWord('/login'),
                encodeWord('=name=' + MIKROTIK_USER),
                encodeWord('=password=' + MIKROTIK_PASS),
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
            } else if (loggedIn) {
                const rawSentences = text.split('\x00');
                let currentItem = {};
                for (const line of rawSentences) {
                    if (line.startsWith('!re')) {
                        if (Object.keys(currentItem).length > 0) results.push(currentItem);
                        currentItem = {};
                    } else if (line.startsWith('=')) {
                        const parts = line.slice(1).split('=');
                        const key = parts[0];
                        const val = parts.slice(1).join('=');
                        currentItem[key] = val;
                    } else if (line.includes('!done') || line.includes('!trap')) {
                        if (Object.keys(currentItem).length > 0) results.push(currentItem);
                        if (!finished) {
                            finished = true;
                            clearTimeout(timer);
                            client.end();
                            resolve(results);
                        }
                    }
                }
            }
        });

        client.on('error', (err) => {
            console.error('[ROUTER SOCKET ERROR]:', err.message);
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                client.destroy();
                resolve(results);
            }
        });

        client.on('close', () => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve(results);
            }
        });
    });
}

// SMS Gateway Helper
async function sendGatewaySMS(toPhone, message) {
    if (!toPhone || toPhone.length < 11) return;
    try {
        await axios.post(SMS_GATEWAY_URL, 'to=' + encodeURIComponent(toPhone) + '&message=' + encodeURIComponent(message), {
            headers: {
                'Authorization': SMS_GATEWAY_TOKEN,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 5000
        });
        console.log('[SMS SENT] To: ' + toPhone);
    } catch (err) {
        console.error('[SMS GATEWAY ERROR]:', err.message);
    }
}

// Carry forward date
function addDaysToDate(baseDateStr, daysToAdd) {
    let base = new Date();
    if (baseDateStr) {
        const parsed = new Date(baseDateStr);
        if (parsed > base) base = parsed;
    }
    base.setDate(base.getDate() + parseInt(daysToAdd, 10));
    return base.toISOString().split('T')[0];
}

// হটস্পট ফাংশনসমূহ
async function ensureUser(username, comment = '') {
    const cmd = ['/user-manager/user/add', '=name=' + username, '=password=' + username, '=group=Hotspot'];
    if (comment) cmd.push('=comment=' + comment);
    await executeSingleCommand(cmd);
}

async function attachProfile(username, profileName) {
    const cmd = ['/user-manager/user-profile/add', '=user=' + username, '=profile=' + profileName];
    return await executeSingleCommand(cmd);
}

async function updateUserComment(username, comment) {
    const cmd = ['/user-manager/user/set', '=numbers=' + username, '=comment=' + comment];
    await executeSingleCommand(cmd);
}

// ========================= API ROUTES =========================

app.get('/', (req, res) => {
    return res.sendFile(path.join(__dirname, 'index.html'));
});

// হটস্পট ভেরিফিকেশন API
app.post('/api/verify-trx', rateLimiter, async (req, res) => {
    try {
        const { username, trxId } = req.body;
        if (!username || !trxId) return res.status(400).json({ success: false, message: 'ইউজার আইডি ও TrxID দিন।' });

        const cleanTrx = trxId.trim().toUpperCase();
        let cleanUser = username.trim().replace(/[^0-9]/g, '');
        if (cleanUser.length >= 11) cleanUser = cleanUser.slice(-11);

        const store = loadJSON(DB_FILE);
        const transaction = store[cleanTrx];

        if (!transaction) return res.status(404).json({ success: false, message: 'ট্রানজেকশন আইডি (' + cleanTrx + ') পাওয়া যায়নি!' });
        if (transaction.used) return res.status(
