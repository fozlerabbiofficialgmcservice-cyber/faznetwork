const express = require('express');
const net = require('net');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION SAFEGUARD]:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION SAFEGUARD]:', reason);
});

const app = express();
const PORT = process.env.PORT || 10000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ফ্রড ও ব্রুট-ফোর্স রোধে মেমোরি রেট লিমিটার
const requestTracker = {};
function rateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    if (!requestTracker[ip]) {
        requestTracker[ip] = { count: 1, resetTime: now + 60000 };
    } else {
        if (now > requestTracker[ip].resetTime) {
            requestTracker[ip] = { count: 1, resetTime: now + 60000 };
        } else {
            requestTracker[ip].count++;
            if (requestTracker[ip].count > 15) {
                return res.status(429).json({
                    success: false,
                    message: 'অতিরিক্ত চেষ্টা করা হয়েছে। ১ মিনিট পর আবার চেষ্টা করুন।'
                });
            }
        }
    }
    next();
}

const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '103.54.37.182';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT) || 1126;
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'smsbot';
const MIKROTIK_PASS = process.env.MIKROTIK_PASSWORD || '66778';

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

const DB_FILE = path.join(__dirname, 'transactions.json');
const CUSTOMERS_FILE = path.join(__dirname, 'customers.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function loadJson(file, defaultVal = {}) {
    try {
        if (!fs.existsSync(file)) return defaultVal;
        return JSON.parse(fs.readFileSync(file, 'utf-8') || JSON.stringify(defaultVal));
    } catch (e) {
        return defaultVal;
    }
}

function saveJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('File write error:', e);
    }
}

// মোবাইল এসএমএস গেটওয়েতে রিকোয়েস্ট পাঠানোর হেল্পার
function triggerPhoneSms(to, message) {
    const settings = loadJson(SETTINGS_FILE, { smsGatewayUrl: '' });
    const gatewayUrl = settings.smsGatewayUrl;
    if (!gatewayUrl) {
        console.log('[SMS WARNING] Gateway URL not configured yet.');
        return Promise.resolve({ success: false, message: 'SMS Gateway URL not configured' });
    }

    return new Promise((resolve) => {
        try {
            const urlObj = new URL(gatewayUrl);
            const isHttps = urlObj.protocol === 'https:';
            const client = isHttps ? https : http;

            const postData = JSON.stringify({
                to: to,
                phone: to,
                message: message,
                text: message
            });

            const req = client.request(urlObj, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 8000
            }, (res) => {
                let resData = '';
                res.on('data', chunk => resData += chunk);
                res.on('end', () => {
                    console.log(`[SMS SENT VIA PHONE] To: ${to} | Response:`, resData);
                    resolve({ success: true, response: resData });
                });
            });

            req.on('error', (err) => {
                console.error('[SMS SEND ERROR]:', err.message);
                resolve({ success: false, error: err.message });
            });

            req.write(postData);
            req.end();
        } catch (err) {
            console.error('[SMS GATEWAY URL INVALID]:', err.message);
            resolve({ success: false, error: err.message });
        }
    });
}

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

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                client.destroy();
                resolve(false);
            }
        }, 6000);

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
            } else if (loggedIn && (text.includes('!done') || text.includes('!trap') || text.includes('!empty'))) {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    client.end();
                    resolve(true);
                }
            }
        });

        client.on('error', (err) => {
            console.error('[ROUTER SOCKET ERROR]:', err.message);
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                client.destroy();
                resolve(false);
            }
        });

        client.on('close', () => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve(true);
            }
        });
    });
}

// মাইক্রোটিক থেকে ডেটা রিড করার হেল্পার ফাংশন
function queryMikrotik(cmdWords) {
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
        }, 6000);

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
            } else if (loggedIn && text.includes('!done')) {
                if (!finished) {
                    finished = true;
                    clearTimeout(
