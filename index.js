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

async function ensureUser(username, comment = '') {
    const cmd = [
        '/user-manager/user/add',
        `=name=${username}`,
        `=password=${username}`,
        `=group=Hotspot`
    ];
    if (comment) cmd.push(`=comment=${comment}`);
    await executeSingleCommand(cmd);
}

async function attachProfile(username, profileName) {
    const cmd = [
        '/user-manager/user-profile/add',
        `=user=${username}`,
        `=profile=${profileName}`
    ];
    return await executeSingleCommand(cmd);
}

async function updateUserComment(username, comment) {
    const cmd = [
        '/user-manager/user/set',
        `=numbers=${username}`,
        `=comment=${comment}`
    ];
    await executeSingleCommand(cmd);
}

// ======================== API ROUTES ========================

// ১. SMS Webhook (বিকাশ ও নগদ ট্রানজেকশন রিসিভ)
app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = (req.query.sender || req.body.sender || req.body.from || '').trim().toLowerCase();

        if (typeof req.body === 'string') sms_body = req.body;

        if (!sender) return res.status(400).json({ success: false, message: 'Sender missing.' });

        const isBkash = sender.includes('bkash') || sender.includes('16247');
        const isNagad = sender.includes('nagad') || sender.includes('16167');

        if (!isBkash && !isNagad) {
            return res.status(403).json({ success: false, message: 'Invalid payment sender.' });
        }

        const trxMatch = sms_body.match(/(?:TrxID|TxnID|TransID|TxId)\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

        const amountMatch = sms_body.match(/(?:Tk|Amount\s*[:]?\s*Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])).toString() : null;

        let detectedPhone = null;
        const phoneMatch = sms_body.match(/(?:Sender|from|number|fee\s*tk\s*[0-9.]+\s*from)\s*[:]?\s*(?:\+?88)?(01[3-9][0-9]{8})/i);
        if (phoneMatch && phoneMatch[1]) detectedPhone = phoneMatch[1].trim();

        if (trxId && amount) {
            const store = loadJson(DB_FILE, {});
            store[trxId] = {
                amount,
                phone: detectedPhone || '',
                gateway: isNagad ? 'Nagad' : 'bKash',
                used: false,
                receivedAt: Date.now()
            };
            saveJson(DB_FILE, store);
            return res.status(200).json({ success: true, trxId, amount, user: detectedPhone });
        }
        return res.status(400).json({ success: false, message: 'TrxID or Amount not found.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ২. হটস্পট ট্রানজেকশন ভেরিফিকেশন ও অটো লগইন
app.post('/api/verify-trx', rateLimiter, async (req, res) => {
    try {
        const { username, trxId } = req.body;
        if (!username || !trxId) return res.status(400).json({ success: false, message: 'তথ্য পূরণ করুন।' });

        const cleanTrx = trxId.trim().toUpperCase();
        let cleanUser = username.trim().replace(/[^0-9]/g, '');
        if (cleanUser.length >= 11) cleanUser = cleanUser.slice(-11);

        const store = loadJson(DB_FILE, {});
        const transaction = store[cleanTrx];

        if (!transaction) return res.status(404).json({ success: false, message: 'ভুল বা অপ্রাপ্ত TrxID!' });
        if (transaction.used) return res.status(400).json({ success: false, message: 'এই TrxID আগেই ব্যবহার করা হয়েছে।' });

        const profile = PRICE_PROFILE_MAP[transaction.amount] || 'Profile-1Hour';
        const commentText = `${transaction.gateway}: ${cleanTrx} | Tk: ${transaction.amount} | Date: ${new Date().toLocaleDateString('en-GB')}`;

        await ensureUser(cleanUser, commentText);
        await attachProfile(cleanUser, profile);
        await updateUserComment(cleanUser, commentText);

        transaction.used = true;
        transaction.activatedUser = cleanUser;
        transaction.usedAt = Date.now();
        saveJson(DB_FILE, store);

        // কাস্টমার ডেটাবেজে স্বয়ংক্রিয় সেভ
        const customers = loadJson(CUSTOMERS_FILE, []);
        const idx = customers.findIndex(c => c.username === cleanUser);
        const custData = {
            username: cleanUser,
            name: cleanUser,
            phone: cleanUser,
            package: profile,
            status: 'Active',
            lastRecharge: new Date().toLocaleDateString('en-GB'),
            balance: transaction.amount,
            comment: commentText
        };
        if (idx !== -1) customers[idx] = { ...customers[idx], ...custData };
        else customers.unshift(custData);
        saveJson(CUSTOMERS_FILE, customers);

        // গ্রাহককে স্বয়ংক্রিয় এসএমএস পাঠানো
        triggerPhoneSms(cleanUser, `FAZ NETWORK: আপনার প্যাকেজ ${profile} সফলভাবে সক্রিয় হয়েছে। ধন্যবাদ!`);

        return res.status(200).json({ success: true, username: cleanUser, password: cleanUser, profile });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ৩. সেটিংস: SMS Gateway Webhook সংরক্ষণ ও পড়া
app.get('/api/settings', (req, res) => {
    const settings = loadJson(SETTINGS_FILE, { smsGatewayUrl: '' });
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const { smsGatewayUrl } = req.body;
    saveJson(SETTINGS_FILE, { smsGatewayUrl: (smsGatewayUrl || '').trim() });
    res.json({ success: true, message: 'এসএমএস গেটওয়ে সফলভাবে সেভ হয়েছে।' });
});

// ৪. কাস্টমার তালিকা API
app.get('/api/customers', (req, res) => {
    const customers = loadJson(CUSTOMERS_FILE, []);
    res.json(customers);
});

// ৫. নির্দিষ্ট গ্রাহকের পূর্ণাঙ্গ তথ্য API
app.get('/api/customer/:username', (req, res) => {
    const customers = loadJson(CUSTOMERS_FILE, []);
    const customer = customers.find(c => c.username === req.params.username);
    if (!customer) return res.status(404).json({ success: false, message: 'গ্রাহক পাওয়া যায়নি।' });
    res.json({ success: true, customer });
});

// ৬. ম্যানুয়ালি কাস্টমার যুক্ত / আপডেট
app.post('/api/customers', (req, res) => {
    const { username, name, phone, package: pkg, status, address } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'ইউজারনেম আবশ্যক।' });

    const customers = loadJson(CUSTOMERS_FILE, []);
    const idx = customers.findIndex(c => c.username === username);
    const newCust = {
        username,
        name: name || username,
        phone: phone || '',
        package: pkg || 'Default',
        status: status || 'Active',
        address: address || '',
        createdAt: new Date().toLocaleDateString('en-GB')
    };

    if (idx !== -1) customers[idx] = { ...customers[idx], ...newCust };
    else customers.unshift(newCust);

    saveJson(CUSTOMERS_FILE, customers);
    res.json({ success: true, message: 'গ্রাহক সফলভাবে সংরক্ষণ করা হয়েছে।' });
});

// ৭. প্যাকেজ লিস্ট পাওয়ার API
app.get('/api/packages', (req, res) => {
    const packages = Object.values(PRICE_PROFILE_MAP);
    res.json({ success: true, packages });
});

// ৮. ড্যাশবোর্ড থেকে SMS পাঠানো API
app.post('/api/send-sms', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, message: 'ফোন নম্বর ও মেসেজ দিন।' });

    const result = await triggerPhoneSms(phone, message);
    if (result.success) {
        res.json({ success: true, message: 'এসএমএস আপনার গেটওয়ে অ্যাপে পাঠানো হয়েছে।' });
    } else {
        res.status(500).json({ success: false, message: 'এস
