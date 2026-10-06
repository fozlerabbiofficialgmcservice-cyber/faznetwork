const express = require('express');
const net = require('net');
const path = require('path');
const fs = require('fs');

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
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

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
const EXPENSES_FILE = path.join(__dirname, 'expenses.json');
const TICKETS_FILE = path.join(__dirname, 'tickets.json');
const EMPLOYEES_FILE = path.join(__dirname, 'employees.json');

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

function loadTransactions() {
    try {
        if (!fs.existsSync(DB_FILE)) return {};
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8') || '{}');
    } catch (e) {
        return {};
    }
}

function saveTransaction(trxId, data) {
    try {
        const store = loadTransactions();
        store[trxId] = data;
        fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
    } catch (e) {
        console.error('File write error:', e);
    }
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

function decodeSentences(buf) {
    const sentences = [];
    let currentWords = [];
    let pos = 0;

    while (pos < buf.length) {
        let b = buf[pos++];
        let len = 0;

        if ((b & 0x80) === 0x00) {
            len = b;
        } else if ((b & 0xC0) === 0x80) {
            if (pos >= buf.length) break;
            len = ((b & ~0xC0) << 8) | buf[pos++];
        } else if ((b & 0xE0) === 0xC0) {
            if (pos + 1 >= buf.length) break;
            len = ((b & ~0xE0) << 16) | (buf[pos++] << 8) | buf[pos++];
        } else if ((b & 0xF0) === 0xE0) {
            if (pos + 2 >= buf.length) break;
            len = ((b & ~0xF0) << 24) | (buf[pos++] << 16) | (buf[pos++] << 8) | buf[pos++];
        } else if ((b & 0xF8) === 0xF0) {
            pos++;
            if (pos + 3 >= buf.length) break;
            len = (buf[pos++] << 24) | (buf[pos++] << 16) | (buf[pos++] << 8) | buf[pos++];
        }

        if (len === 0) {
            if (currentWords.length > 0) {
                sentences.push(currentWords);
                currentWords = [];
            }
            continue;
        }

        if (pos + len > buf.length) break;
        const word = buf.slice(pos, pos + len).toString('utf-8');
        pos += len;
        currentWords.push(word);
    }

    return sentences;
}

function runMikrotikApi(commands) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let rawBuffer = Buffer.alloc(0);
        let loggedIn = false;
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                client.destroy();
                resolve([]);
            }
        }, 10000);

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
            rawBuffer = Buffer.concat([rawBuffer, chunk]);
            const sentences = decodeSentences(rawBuffer);

            for (const s of sentences) {
                if (!loggedIn && (s.includes('!done') || s.includes('!trap'))) {
                    loggedIn = true;
                    rawBuffer = Buffer.alloc(0);
                    const payload = commands.map(w => encodeWord(w));
                    payload.push(Buffer.from([0x00]));
                    client.write(Buffer.concat(payload));
                    return;
                } else if (loggedIn && s.includes('!done')) {
                    if (!finished) {
                        finished = true;
                        clearTimeout(timer);
                        client.end();

                        const results = [];
                        for (const item of sentences) {
                            if (item[0] === '!re' || Array.isArray(item) && item.some(w => w.startsWith('='))) {
                                const obj = {};
                                for (let i = 0; i < item.length; i++) {
                                    if (item[i].startsWith('=')) {
                                        const eqPos = item[i].indexOf('=', 1);
                                        if (eqPos > 1) {
                                            const k = item[i].substring(1, eqPos);
                                            const v = item[i].substring(eqPos + 1);
                                            obj[k] = v;
                                        }
                                    }
                                }
                                results.push(obj);
                            }
                        }
                        resolve(results);
                        return;
                    }
                }
            }
        });

        client.on('error', (err) => {
            console.error('[ROUTER API ERROR]:', err.message);
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                client.destroy();
                resolve([]);
            }
        });

        client.on('close', () => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve([]);
            }
        });
    });
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
        }, 10000);

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
            const sentences = decodeSentences(buffer);

            for (const s of sentences) {
                if (!loggedIn && (s.includes('!done') || s.includes('!trap'))) {
                    loggedIn = true;
                    buffer = Buffer.alloc(0);
                    const payload = cmdWords.map(w => encodeWord(w));
                    payload.push(Buffer.from([0x00]));
                    client.write(Buffer.concat(payload));
                    return;
                } else if (loggedIn && (s.includes('!done') || s.includes('!trap') || s.includes('!empty'))) {
                    if (!finished) {
                        finished = true;
                        clearTimeout(timer);
                        client.end();
                        resolve(true);
                    }
                }
            }
        });

        client.on('error', (err) => {
            console.error('[ROUTER CMD ERROR]:', err.message);
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
    console.log(`[USER MANAGER] Ensuring user: ${username}`);
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
    console.log(`[USER MANAGER] Attaching/Renewing profile: ${username} -> ${profileName}`);
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

function formatBytes(bytes) {
    const b = parseInt(bytes) || 0;
    if (b === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

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
            if (requestTracker[ip].count > 10) {
                return res.status(429).json({
                    success: false,
                    message: 'অতিরিক্ত চেষ্টা করা হয়েছে। অনুগ্রহ করে ১ মিনিট পর আবার চেষ্টা করুন।'
                });
            }
        }
    }
    next();
}

app.get('/', (req, res) => {
    return res.status(200).send('FAZ NETWORK Hotspot & Billing API is Running!');
});

app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = (req.query.sender || req.body.sender || req.body.from || '').trim().toLowerCase();

        if (typeof req.body === 'string') sms_body = req.body;
        console.log(`[INCOMING SMS RAW] Sender: "${sender}" | Body: "${sms_body}"`);

        if (!sender) {
            console.warn('[BLOCKED] Sender information is missing.');
            return res.status(400).json({ success: false, message: 'Sender information missing.' });
        }

        const isBkashSender = sender.includes('bkash') || sender.includes('16247');
        const isNagadSender = sender.includes('nagad') || sender.includes('16167');

        if (!isBkashSender && !isNagadSender) {
            console.warn(`[FRAUD ALERT] Blocked SMS from non-official sender: ${sender}`);
            return res.status(403).json({
                success: false,
                message: 'Rejected: SMS is not from official bKash or Nagad sender.'
            });
        }

        const isBkashFormat = /You have received (?:Tk|deposit)|Cash In Tk/i.test(sms_body);
        const isNagadFormat = /Money Received|Cash In amount/i.test(sms_body);

        if (!isBkashFormat && !isNagadFormat) {
            console.warn('[REJECTED] SMS does not match official payment confirmation pattern.');
            return res.status(400).json({ success: false, message: 'Invalid payment SMS format.' });
        }

        const trxMatch = sms_body.match(/(?:TrxID|TxnID|TransID|TxId)\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

        const amountMatch = sms_body.match(/(?:Tk|Amount\s*[:]?\s*Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])).toString() : null;

        let detectedPhone = null;
        const phoneMatch = sms_body.match(/(?:Sender|from|number|fee\s*tk\s*[0-9.]+\s*from)\s*[:]?\s*(?:\+?88)?(01[3-9][0-9]{8})/i);
        if (phoneMatch && phoneMatch[1]) {
            detectedPhone = phoneMatch[1].trim();
        }

        if (trxId && amount) {
            saveTransaction(trxId, {
                amount: amount,
                phone: detectedPhone || '',
                gateway: isNagadSender ? 'Nagad' : 'bKash',
                used: false,
                receivedAt: Date.now()
            });
            console.log(`[TRX SAVED] Gateway: ${isNagadSender ? 'Nagad' : 'bKash'} | ID: ${trxId} | Amount: ${amount} Tk | Phone: ${detectedPhone || 'N/A'}`);
            return res.status(200).json({ success: true, trxId, amount, user: detectedPhone });
        } else {
            console.warn('[REJECTED] Incomplete transaction data in SMS.');
            return res.status(400).json({ success: false, message: 'Invalid SMS content, TrxID/TxnID or Amount not found.' });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/verify-trx', rateLimiter, async (req, res) => {
    try {
        const { username, trxId } = req.body;

        if (!username || !trxId) {
            return res.status(400).json({ success: false, message: 'ইউজার আইডি ও TrxID / TxnID দিন।' });
        }

        const cleanTrx = trxId.trim().toUpperCase();
        let cleanUser = username.trim().replace(/[^0-9]/g, '');
        if (cleanUser.length >= 11) cleanUser = cleanUser.slice(-11);

        const store = loadTransactions();
        const transaction = store[cleanTrx];

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: `ট্রানজেকশন আইডি (${cleanTrx}) পাওয়া যায়নি! বিকাশ বা নগদের সঠিক TrxID/TxnID দিন।`
            });
        }

        if (transaction.used) {
            return res.status(400).json({
                success: false,
                message: 'এই আইডি দিয়ে আগেই ইন্টারনেট সক্রিয় করা হয়েছে।'
            });
        }

        const profile = PRICE_PROFILE_MAP[transaction.amount] || 'Profile-1Hour';
        const senderInfo = transaction.phone ? ` | Payer: ${transaction.phone}` : '';
        const method = transaction.gateway || 'Pay';
        const commentText = `${method}: ${cleanTrx} | Tk: ${transaction.amount}${senderInfo} | Date: ${new Date().toLocaleDateString('en-GB')}`;

        await ensureUser(cleanUser, commentText);
        await attachProfile(cleanUser, profile);
        await updateUserComment(cleanUser, commentText);

        transaction.used = true;
        transaction.activatedUser = cleanUser;
        transaction.usedAt = Date.now();
        saveTransaction(cleanTrx, transaction);

        console.log(`[SUCCESS] User: ${cleanUser} recharged via ${method} (${cleanTrx}) - ${transaction.amount} Tk`);

        return res.status(200).json({
            success: true,
            message: `সফল হয়েছে! প্যাকেজ: ${profile}`,
            username: cleanUser,
            password: cleanUser,
            profile: profile
        });
    } catch (err) {
        console.error('[VERIFY ERROR]:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [pppActive, hsActive, pppSecrets, hsUsers, umUsers] = await Promise.all([
            runMikrotikApi(['/ppp/active/print']),
            runMikrotikApi(['/ip/hotspot/active/print']),
            runMikrotikApi(['/ppp/secret/print']),
            runMikrotikApi(['/ip/hotspot/user/print']),
            runMikrotikApi(['/user-manager/user/print'])
        ]);

        res.json({
            success: true,
            stats: {
                totalCustomers: (pppSecrets || []).length,
                onlinePppoe: (pppActive || []).length,
                totalHotspotUsers: (hsUsers || []).length + (umUsers || []).length,
                onlineHotspot: (hsActive || []).length
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/hotspot/users', async (req, res) => {
    try {
        const [hsUsers, umUsers, hsActive, umActive] = await Promise.all([
            runMikrotikApi(['/ip/hotspot/user/print']),
            runMikrotikApi(['/user-manager/user/print']),
            runMikrotikApi(['/ip/hotspot/active/print']),
            runMikrotikApi(['/user-manager/session/print'])
        ]);

        const activeMap = {};
        (hsActive || []).forEach(a => {
            const u = (a.user || a.name || '').trim().toLowerCase();
            if (u) {
                activeMap[u] = {
                    ip: a.address || a.ip || '-',
                    mac: a['mac-address'] || a.mac || '-',
                    uptime: a.uptime || '-',
                    bytesIn: formatBytes(a['bytes-in']),
                    bytesOut: formatBytes(a['bytes-out'])
                };
            }
        });

        (umActive || []).forEach(s => {
            const u = (s.user || s.username || '').trim().toLowerCase();
            if (u && !activeMap[u]) {
                activeMap[u] = {
                    ip: s['host-ip'] || s.address || '-',
                    mac: s['calling-station-id'] || s.mac || '-',
                    uptime: s.uptime || '-',
                    bytesIn: formatBytes(s['download'] || s['bytes-in']),
                    bytesOut: formatBytes(s['upload'] || s['bytes-out'])
                };
            }
        });

        const list = [];
        (hsUsers || []).forEach(u => {
            const uname = (u.name || u.username || '').trim();
            if (!uname || uname.toLowerCase() === 'default-trial' || uname.toLowerCase() === 'default') return;

            const live = activeMap[uname.toLowerCase()];

            list.push({
                id: u['.id'],
                server: u.server || 'all',
                name: uname,
                username: uname,
                profile: u.profile || 'default',
                ip: live ? live.ip : '-',
                mac: live ? live.mac : (u['mac-address'] || '-'),
                uptime: live ? live.uptime : '-',
                limitUptime: u['limit-uptime'] || 'Unlimited',
                bytesIn: live ? live.bytesIn : formatBytes(u['bytes-in']),
                bytesOut: live ? live.bytesOut : formatBytes(u['bytes-out']),
                comment: u.comment || '',
                disabled: u.disabled === 'true' || u.disabled === 'yes',
                isOnline: !!live
            });
        });

        (umUsers || []).forEach(u => {
            const uname = (u.name || u.username || '').trim();
            if (!uname || uname.toLowerCase() === 'default-trial' || uname.toLowerCase() === 'default') return;

            const live = activeMap[uname.toLowerCase()];

            list.push({
                id: u['.id'],
                server: 'User-Manager',
                name: uname,
                username: uname,
                profile: u.group || u.profile || 'Hotspot',
                ip: live ? live.ip : '-',
                mac: live ? live.mac : (u['caller-id'] || '-'),
                uptime: live ? live.uptime : '-',
                limitUptime: 'Managed',
                bytesIn: live ? live.bytesIn : '-',
                bytesOut: live ? live.bytesOut : '-',
                comment: u.comment || '',
                disabled: u.disabled === 'true' || u.disabled === 'yes',
                isOnline: !!live
            });
        });

        res.json(list);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.post('/api/hotspot/active/remove', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ success: false, message: 'Username is required' });

        const [hsActives, umSessions] = await Promise.all([
            runMikrotikApi(['/ip/hotspot/active/print', `?user=${username.trim()}`]),
            runMikrotikApi(['/user-manager/session/print', `?user=${username.trim()}`])
        ]);

        let disconnected = false;
        for (const act of (hsActives || [])) {
            if (act['.id']) {
                await executeSingleCommand(['/ip/hotspot/active/remove', `=.id=${act['.id']}`]);
                disconnected = true;
            }
        }
        for (const sess of (umSessions || [])) {
            if (sess['.id']) {
                await executeSingleCommand(['/user-manager/session/remove', `=.id=${sess['.id']}`]);
                disconnected = true;
            }
        }
        res.json({ success: true, message: disconnected ? 'User disconnected' : 'User not active' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/hotspot/users/status', async (req, res) => {
    try {
        const { username, disabled } = req.body;
        if (!username) return res.status(400).json({ success: false, message: 'Username is required' });
        const disableVal = disabled ? 'yes' : 'no';

        const [hsUsers, umUsers] = await Promise.all([
            runMikrotikApi(['/ip/hotspot/user/print', `?name=${username.trim()}`]),
            runMikrotikApi(['/user-manager/user/print', `?name=${username.trim()}`])
        ]);

        for (const u of (hsUsers || [])) {
            if (u['.id']) {
                await executeSingleCommand(['/ip/hotspot/user/set', `=.id=${u['.id']}`, `=disabled=${disableVal}`]);
            }
        }
        for (const u of (umUsers || [])) {
            if (u['.id']) {
                await executeSingleCommand(['/user-manager/user/set', `=.id=${u['.id']}`, `=disabled=${disableVal}`]);
            }
        }
        if (disabled) {
            const actives = await runMikrotikApi(['/ip/hotspot/active/print', `?user=${username.trim()}`]);
            for (const a of (actives || [])) {
                if (a['.id']) await executeSingleCommand(['/ip/hotspot/active/remove', `=.id=${a['.id']}`]);
            }
        }
        res.json({ success: true, message: `User status updated` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/hotspot/users', async (req, res) => {
    try {
        const { username, password, profile, server, limitUptime, comment } = req.body;
        if (!username) return res.status(400).json({ success: false, message: 'Username is required' });

        const cmd = [
            '/ip/hotspot/user/add',
            `=name=${username.trim()}`,
            `=password=${(password || '').trim()}`,
            `=profile=${profile || 'default'}`,
            `=server=${server || 'all'}`
        ];
        if (limitUptime) cmd.push(`=limit-uptime=${limitUptime}`);
        if (comment) cmd.push(`=comment=${comment}`);

        const result = await executeSingleCommand(cmd);
        res.json({ success: result, message: result ? 'User created!' : 'Failed on router' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/hotspot/users/:name', async (req, res) => {
    try {
        const username = req.params.name;
        const hsUsers = await runMikrotikApi(['/ip/hotspot/user/print', `?name=${username}`]);
        if (hsUsers && hsUsers.length > 0) {
            await executeSingleCommand(['/ip/hotspot/user/remove', `=.id=${hsUsers[0]['.id']}`]);
        }
        const umUsers = await runMikrotikApi(['/user-manager/user/print', `?name=${username}`]);
        if (umUsers && umUsers.length > 0) {
            await executeSingleCommand(['/user-manager/user/remove', `=.id=${umUsers[0]['.id']}`]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/hotspot/profiles', async (req, res) => {
    try {
        const [hsProfiles, umProfiles] = await Promise.all([
            runMikrotikApi(['/ip/hotspot/user/profile/print']),
            runMikrotikApi(['/user-manager/profile/print'])
        ]);
        const combinedProfiles = [];
        (hsProfiles || []).forEach(p => combinedProfiles.push({ name: p.name }));
        (umProfiles || []).forEach(p => {
            if (!combinedProfiles.some(cp => cp.name === p.name)) {
                combinedProfiles.push({ name: p.name });
            }
        });
        res.json(combinedProfiles);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.get('/api/hotspot/server-profiles', async (req, res) => {
    try {
        const servers = await runMikrotikApi(['/ip/hotspot/print']);
        if (servers && servers.length > 0) {
            res.json(servers.map(s => ({ name: s.name })));
        } else {
            res.json([{ name: 'all' }, { name: 'hotspot1' }]);
        }
    } catch (err) {
        res.status(500).json([{ name: 'all' }]);
    }
});

app.get('/api/customers', async (req, res) => {
    try {
        const [pppSecrets, pppActive] = await Promise.all([
            runMikrotikApi(['/ppp/secret/print']),
            runMikrotikApi(['/ppp/active/print'])
        ]);
        
        const localCustomers = loadJson(CUSTOMERS_FILE, []);
        const activeUserMap = {};
        (pppActive || []).forEach(a => { if (a && a.name) activeUserMap[a.name] = a; });

        const customersMap = {};
        for (const cust of localCustomers) {
            if (cust && cust.username) customersMap[cust.username] = cust;
        }

        const validSecrets = (pppSecrets || []).filter(s => s && s.name && s.name !== 'undefined');

        const combined = validSecrets.map(secret => {
            const uName = secret.name.trim();
            const extra = customersMap[uName] || {};
            const isDisabled = secret.disabled === 'true' || secret.disabled === 'yes';
            const isActive = !!activeUserMap[uName];

            let expiry = extra.expiryDate || '';
            if (!expiry && secret.comment) {
                const match = secret.comment.match(/Exp:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
                if (match) expiry = match[1];
            }

            return {
                username: uName,
                name: extra.fullName || extra.name || uName,
                phone: extra.phoneNumber || extra.phone || '-',
                package: secret.profile || extra.package || 'Default',
                service: secret.service || 'pppoe',
                status: isDisabled ? 'Disabled' : 'Active',
                onlineStatus: isActive ? 'Online' : 'Offline',
                callerId: activeUserMap[uName] ? activeUserMap[uName]['caller-id'] : '-',
                ipAddress: activeUserMap[uName] ? activeUserMap[uName].address : (secret['remote-address'] || '-'),
                uptime: activeUserMap[uName] ? activeUserMap[uName].uptime : '-',
                expiryDate: expiry || 'N/A',
                address: extra.fullAddress || extra.address || '-',
                comment: secret.comment || ''
            };
        });

        for (const localCust of localCustomers) {
            if (localCust && localCust.username && !combined.some(c => c.username === localCust.username)) {
                combined.push(localCust);
            }
        }

        res.json(combined);
    } catch (err) {
        console.error('Fetch customers error:', err);
        res.json(loadJson(CUSTOMERS_FILE, []));
    }
});

app.post('/api/customers', async (req, res) => {
    try {
        const {
            username,
            password,
            package: pkg,
            fullName,
            phoneNumber,
            fullAddress,
            nidPassport,
            billingDuration,
            customExpiryDate
        } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username & Password are required.' });
        }

        let calculatedExpiry = '';
        if (billingDuration === 'custom' && customExpiryDate) {
            calculatedExpiry = customExpiryDate;
        } else {
            const now = new Date();
            let months = 1;
            if (billingDuration === '3_months') months = 3;
            else if (billingDuration === '6_months') months = 6;
            else if (billingDuration === '1_year' || billingDuration === '12_months') months = 12;

            now.setMonth(now.getMonth() + months);
            calculatedExpiry = now.toISOString().split('T')[0];
        }

        const commentText = `Exp: ${calculatedExpiry} | Phone: ${phoneNumber || 'N/A'}`;

        const cmd = [
            '/ppp/secret/add',
            `=name=${username.trim()}`,
            `=password=${password.trim()}`,
            `=service=pppoe`,
            `=profile=${pkg || 'default'}`,
            `=comment=${commentText}`
        ];

        let created = await executeSingleCommand(cmd);
        if (!created) {
            await executeSingleCommand([
                '/ppp/secret/set',
                `=numbers=${username.trim()}`,
                `=password=${password.trim()}`,
                `=profile=${pkg || 'default'}`,
                `=comment=${commentText}`,
                `=disabled=no`
            ]);
        }

        const customers = loadJson(CUSTOMERS_FILE, []);
        const idx = customers.findIndex(c => c.username === username.trim());
        const record = {
            username: username.trim(),
            password: password.trim(),
            name: fullName || username.trim(),
            phone: phoneNumber || '',
            package: pkg || 'default',
            status: 'Active',
            billingDuration: billingDuration,
            expiryDate: calculatedExpiry,
            address: fullAddress || '',
            nidPassport: nidPassport || ''
        };

        if (idx !== -1) customers[idx] = Object.assign({}, customers[idx], record);
        else customers.unshift(record);

        saveJson(CUSTOMERS_FILE, customers);

        res.json({ success: true, message: 'Customer saved successfully!', expiryDate: calculatedExpiry });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/packages', async (req, res) => {
    try {
        const profiles = await runMikrotikApi(['/ppp/profile/print']);
        const packageList = (profiles || [])
            .map(p => p.name)
            .filter(name => name && !['default', 'default-encryption'].includes(name.toLowerCase()))
            .map(name => ({
                name: name,
                price: ''
            }));

        res.json({ success: true, packages: packageList });
    } catch (e) {
        res.json({ success: true, packages: [] });
    }
});

app.get('/api/core/ip-pools', async (req, res) => {
    try {
        const pools = await runMikrotikApi(['/ip/pool/print']);
        res.json(pools || []);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.get('/api/core/interfaces', async (req, res) => {
    try {
        const interfaces = await runMikrotikApi(['/interface/print']);
        res.json(interfaces || []);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.get('/api/payments', (req, res) => {
    const list = loadJson(DB_FILE, {});
    if (Array.isArray(list)) return res.json(list);
    const arr = Object.keys(list).map(k => ({ trxId: k, ...list[k] }));
    res.json(arr);
});

app.post('/api/payments', (req, res) => {
    const { trxId, ...rest } = req.body;
    if (trxId) {
        saveTransaction(trxId, rest);
    }
    res.json({ success: true });
});

app.get('/api/expenses', (req, res) => res.json(loadJson(EXPENSES_FILE, [])));
app.post('/api/expenses', (req, res) => {
    const list = loadJson(EXPENSES_FILE, []);
    const record = Object.assign({ id: Date.now(), date: new Date().toISOString() }, req.body);
    list.unshift(record);
    saveJson(EXPENSES_FILE, list);
    res.json({ success: true });
});

app.get('/api/support/tickets', (req, res) => res.json(loadJson(TICKETS_FILE, [])));
app.post('/api/support/tickets', (req, res) => {
    const list = loadJson(TICKETS_FILE, []);
    list.unshift(Object.assign({ id: 'TKT-' + Date.now(), createdAt: new Date().toISOString(), status: 'Open' }, req.body));
    saveJson(TICKETS_FILE, list);
    res.json({ success: true });
});

app.get('/api/hr/employees', (req, res) => res.json(loadJson(EMPLOYEES_FILE, [])));
app.post('/api/hr/employees', (req, res) => {
    const list = loadJson(EMPLOYEES_FILE, []);
    list.unshift(Object.assign({ id: Date.now() }, req.body));
    saveJson(EMPLOYEES_FILE, list);
    res.json({ success: true });
});

app.get('/api/settings', (req, res) => {
    res.json(loadJson(SETTINGS_FILE, { smsGatewayUrl: '' }));
});

app.post('/api/settings', (req, res) => {
    saveJson(SETTINGS_FILE, { smsGatewayUrl: (req.body.smsGatewayUrl || '').trim() });
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
