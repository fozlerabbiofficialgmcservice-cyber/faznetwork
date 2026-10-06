const express = require('express');
const net = require('net');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

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
    try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
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
    } catch (e) {
        next();
    }
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
        console.error(`Error saving ${filePath}:`, e.message);
    }
}

// MikroTik Binary API
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
        }, 5000);

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
        await axios.post(SMS_GATEWAY_URL, `to=${encodeURIComponent(toPhone)}&message=${encodeURIComponent(message)}`, {
            headers: {
                'Authorization': SMS_GATEWAY_TOKEN,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 5000
        });
    } catch (err) {
        console.error(`[SMS GATEWAY ERROR]:`, err.message);
    }
}

function addDaysToDate(baseDateStr, daysToAdd) {
    let base = new Date();
    if (baseDateStr) {
        const parsed = new Date(baseDateStr);
        if (parsed > base) base = parsed;
    }
    base.setDate(base.getDate() + parseInt(daysToAdd, 10));
    return base.toISOString().split('T')[0];
}

// Hotspot Helpers
async function ensureUser(username, comment = '') {
    const cmd = ['/user-manager/user/add', `=name=${username}`, `=password=${username}`, `=group=Hotspot`];
    if (comment) cmd.push(`=comment=${comment}`);
    await executeSingleCommand(cmd);
}

async function attachProfile(username, profileName) {
    const cmd = ['/user-manager/user-profile/add', `=user=${username}`, `=profile=${profileName}`];
    return await executeSingleCommand(cmd);
}

async function updateUserComment(username, comment) {
    const cmd = ['/user-manager/user/set', `=numbers=${username}`, `=comment=${comment}`];
    await executeSingleCommand(cmd);
}

// ========================= ROUTES =========================

app.get('/', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'admin.html'))) {
        return res.sendFile(path.join(__dirname, 'admin.html'));
    }
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

        if (!transaction) return res.status(404).json({ success: false, message: `ট্রানজেকশন আইডি (${cleanTrx}) পাওয়া যায়নি!` });
        if (transaction.used) return res.status(400).json({ success: false, message: 'এই আইডি দিয়ে আগেই ইন্টারনেট সক্রিয় করা হয়েছে।' });

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
        saveJSON(DB_FILE, store);

        return res.status(200).json({
            success: true,
            message: `সফল হয়েছে! প্যাকেজ: ${profile}`,
            username: cleanUser,
            password: cleanUser,
            profile: profile
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// MacroDroid SMS Forward Webhook
app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = (req.query.sender || req.body.sender || req.body.from || '').trim().toLowerCase();

        if (typeof req.body === 'string') sms_body = req.body;
        console.log(`[INCOMING SMS RAW] Sender: "${sender}" | Body: "${sms_body}"`);

        const isBkashSender = sender.includes('bkash') || sender.includes('16247');
        const isNagadSender = sender.includes('nagad') || sender.includes('16167');

        const trxMatch = sms_body.match(/(?:TrxID|TxnID|TransID|TxId)\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

        const amountMatch = sms_body.match(/(?:Tk|Amount\s*[:]?\s*Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])).toString() : null;

        const refMatch = sms_body.match(/(?:Ref|Reference)\s*[:]?\s*([A-Za-z0-9_-]+)/i);
        const referenceUser = refMatch ? refMatch[1].trim() : null;

        if (trxId && amount) {
            const customers = loadJSON(CUSTOMERS_FILE);

            if (referenceUser && (customers[referenceUser] || referenceUser === '100001')) {
                let cust = customers[referenceUser] || {
                    name: referenceUser,
                    username: referenceUser,
                    phone: '',
                    profile: 'FZN 30 Mbps',
                    bill: amount,
                    status: 'active',
                    expireDate: new Date().toISOString().split('T')[0],
                    history: []
                };

                const newExp = addDaysToDate(cust.expireDate, 30);
                cust.expireDate = newExp;
                cust.status = 'active';

                const commentText = `Exp: ${newExp}`;

                await executeSingleCommand([
                    '/ppp/secret/set',
                    `=numbers=${referenceUser}`,
                    `=profile=${cust.profile || 'FZN 30 Mbps'}`,
                    `=comment=${commentText}`,
                    `=disabled=no`
                ]);
                await executeSingleCommand(['/ppp/active/remove', `?name=${referenceUser}`]);

                if (!Array.isArray(cust.history)) cust.history = [];
                cust.history.unshift({
                    date: new Date().toISOString(),
                    amount: amount,
                    type: isNagadSender ? 'Nagad Auto' : 'bKash Auto',
                    trxId: trxId
                });

                customers[referenceUser] = cust;
                saveJSON(CUSTOMERS_FILE, customers);

                if (cust.phone) {
                    await sendGatewaySMS(cust.phone, `Prio Grahok (User: ${referenceUser}), apnar ${amount} tk bill grohon kora hoyeche. Notun meyad: ${newExp} porjonto. Dhonnobad!`);
                }

                console.log(`[PPPoE AUTO RENEWED]: ${referenceUser} -> ${newExp}`);
                return res.status(200).json({ success: true, type: 'PPPoE', user: referenceUser, expireDate: newExp });
            }

            const store = loadJSON(DB_FILE);
            store[trxId] = {
                amount: amount,
                gateway: isNagadSender ? 'Nagad' : 'bKash',
                used: false,
                receivedAt: Date.now()
            };
            saveJSON(DB_FILE, store);
            return res.status(200).json({ success: true, type: 'Hotspot', trxId, amount });
        }

        return res.status(400).json({ success: false, message: 'Invalid SMS content.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ========================= অ্যাডমিন ড্যাশবোর্ড API =========================

// কাস্টমার তালিকা (মাইক্রোটিক লাইভ + লোকাল ব্যাকআপ)
app.get('/api/admin/customers', async (req, res) => {
    try {
        let fileCustomers = loadJSON(CUSTOMERS_FILE);
        if (!fileCustomers || typeof fileCustomers !== 'object' || Array.isArray(fileCustomers)) {
            fileCustomers = {};
        }

        const [activeUsers, secrets] = await Promise.all([
            executeSingleCommand(['/ppp/active/print']),
            executeSingleCommand(['/ppp/secret/print'])
        ]);

        const activeMap = {};
        if (Array.isArray(activeUsers)) {
            activeUsers.forEach(u => {
                const uName = u.name || u['=name'];
                if (uName) {
                    activeMap[uName] = {
                        uptime: u.uptime || u['=uptime'] || 'Online',
                        address: u.address || u['=address'] || 'N/A',
                        callerId: u['caller-id'] || u['=caller-id'] || ''
                    };
                }
            });
        }

        // মাইক্রোটিকের সব ইউজার ইন্টিগ্রেট করা
        if (Array.isArray(secrets) && secrets.length > 0) {
            secrets.forEach(sec => {
                const sName = sec.name || sec['=name'];
                if (!sName) return;

                let exp = null;
                const comment = sec.comment || sec['=comment'] || '';
                if (comment) {
                    const m = comment.match(/Exp:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
                    if (m) exp = m[1];
                }

                const sProfile = sec.profile || sec['=profile'] || 'Default';
                const sCallerId = sec['caller-id'] || sec['=caller-id'] || '';
                const isDisabled = (sec.disabled === 'true' || sec['=disabled'] === 'true');

                if (!fileCustomers[sName]) {
                    fileCustomers[sName] = {
                        name: sName,
                        username: sName,
                        password: sec.password || sec['=password'] || '1234',
                        connectionType: 'PPPoE',
                        phone: '',
                        profile: sProfile,
                        bill: 500,
                        status: isDisabled ? 'suspended' : 'active',
                        expireDate: exp || '2026-11-05',
                        callerId: sCallerId,
                        history: []
                    };
                } else {
                    fileCustomers[sName].profile = sProfile;
                    if (sCallerId) fileCustomers[sName].callerId = sCallerId;
                    if (exp) fileCustomers[sName].expireDate = exp;
                    if (isDisabled) fileCustomers[sName].status = 'suspended';
                }
            });
            saveJSON(CUSTOMERS_FILE, fileCustomers);
        }

        const today = new Date().toISOString().split('T')[0];

        const list = Object.keys(fileCustomers).map(key => {
            const c = fileCustomers[key];
            let liveStatus = 'offline';
            if (c.status === 'suspended' || c.profile === 'Expired_Profile') {
                liveStatus = 'suspended';
            } else if (c.status === 'terminated') {
                liveStatus = 'terminated';
            } else if (c.expireDate && c.expireDate < today) {
                liveStatus = 'expired';
            } else if (activeMap[c.username]) {
                liveStatus = 'active';
            }

            return {
                ...c,
                liveStatus,
                uptime: activeMap[c.username] ? activeMap[c.username].uptime : 'Offline',
                ipAddress: activeMap[c.username] ? activeMap[c.username].address : (c.ipAddress || 'N/A'),
                callerId: activeMap[c.username] ? (activeMap[c.username].callerId || c.callerId) : (c.callerId || 'N/A')
            };
        });

        res.json({ success: true, customers: list });
    } catch (e) {
        console.error('[CUSTOMERS ROUTE ERROR]:', e.message);
        res.status(500).json({ success: false, error: e.message, customers: [] });
    }
});

// কাস্টমার যোগ
app.post('/api/admin/customers/add', async (req, res) => {
    try {
        const { name, username, password, connectionType, phone, profile, bill, expireDate } = req.body;
        if (!username || !password || !profile) {
            return res.status(400).json({ success: false, message: 'ইউজারনেম, পাসওয়ার্ড ও প্রোফাইল আবশ্যক।' });
        }

        const customers = loadJSON(CUSTOMERS_FILE);
        const exp = expireDate || addDaysToDate(null, 30);
        const comment = `Exp: ${exp}`;

        await executeSingleCommand([
            '/ppp/secret/add',
            `=name=${username}`,
            `=password=${password}`,
            `=service=${connectionType === 'Static IP' ? 'any' : 'pppoe'}`,
            `=profile=${profile}`,
            `=comment=${comment}`
        ]);

        customers[username] = {
            name: name || username,
            username,
            password,
            connectionType: connectionType || 'PPPoE',
            phone: phone || '',
            profile,
            bill: bill || 500,
            status: 'active',
            expireDate: exp,
            createdAt: new Date().toISOString(),
            history: [{
                date: new Date().toISOString(),
                amount: bill || 500,
                type: 'Creation',
                trxId: 'ADMIN-CASH'
            }]
        };

        saveJSON(CUSTOMERS_FILE, customers);
        res.json({ success: true, message: 'কাস্টমার সফলভাবে তৈরি হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// কাস্টমার অ্যাকশন (রিনিউ, স্ট্যাটাস, নোটিশ)
app.post('/api/admin/customers/action', async (req, res) => {
    try {
        const { username, action, days, amount, status } = req.body;
        const customers = loadJSON(CUSTOMERS_FILE);
        const cust = customers[username];

        if (!cust) return res.status(404).json({ success: false, message: 'কাস্টমার পাওয়া যায়নি।' });

        if (action === 'renew') {
            const addDays = parseInt(days, 10) || 30;
            const newExp = addDaysToDate(cust.expireDate, addDays);
            cust.expireDate = newExp;
            cust.status = 'active';

            const comment = `Exp: ${newExp}`;

            await executeSingleCommand([
                '/ppp/secret/set',
                `=numbers=${username}`,
                `=profile=${cust.profile === 'Expired_Profile' ? 'FZN 30 Mbps' : cust.profile}`,
                `=disabled=no`,
                `=comment=${comment}`
            ]);
            await executeSingleCommand(['/ppp/active/remove', `?name=${username}`]);

            if (!Array.isArray(cust.history)) cust.history = [];
            cust.history.unshift({
                date: new Date().toISOString(),
                amount: amount || cust.bill,
                type: 'Manual Renew',
                trxId: 'ADMIN-PAID'
            });

            if (cust.phone) {
                await sendGatewaySMS(cust.phone, `Prio Grahok (User: ${username}), apnar internet line renew kora hoyeche. Notun meyad: ${newExp} porjonto.`);
            }

        } else if (action === 'status') {
            cust.status = status;
            if (status === 'suspended' || status === 'expired') {
                await executeSingleCommand(['/ppp/secret/set', `=numbers=${username}`, `=profile=Expired_Profile`]);
                await executeSingleCommand(['/ppp/active/remove', `?name=${username}`]);
            } else if (status === 'active') {
                await executeSingleCommand(['/ppp/secret/set', `=numbers=${username}`, `=profile=${cust.profile === 'Expired_Profile' ? 'FZN 30 Mbps' : cust.profile}`, `=disabled=no`]);
            } else if (status === 'terminated') {
                await executeSingleCommand(['/ppp/secret/set', `=numbers=${username}`, `=disabled=yes`]);
                await executeSingleCommand(['/ppp/active/remove', `?name=${username}`]);
            }
        } else if (action === 'send-notice') {
            if (!cust.phone) return res.status(400).json({ success: false, message: 'কাস্টমারের ফোন নম্বর নেই।' });
            await sendGatewaySMS(cust.phone, `Prio Grahok (User: ${username}), apnar internet package-er meyad shesh hoyeche. Shongjog shochol rakhte bKash/Nagad Send Money-te Reference-e "${username}" likhe bill porishodh korun.`);
            return res.json({ success: true, message: 'নোটিশ এসএমএস পাঠানো হয়েছে!' });
        }

        saveJSON(CUSTOMERS_FILE, customers);
        res.json({ success: true, message: 'অ্যাকশন সফল হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// আইপি পুল হ্যান্ডলার
app.get('/api/admin/pools', async (req, res) => {
    try {
        const pools = await executeSingleCommand(['/ip/pool/print']);
        res.json({ success: true, pools: Array.isArray(pools) ? pools : [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, pools: [] });
    }
});

app.post('/api/admin/pools/add', async (req, res) => {
    try {
        const { name, ranges } = req.body;
        if (!name || !ranges) return res.status(400).json({ success: false, message: 'নাম ও রেঞ্জ দিন।' });

        await executeSingleCommand(['/ip/pool/add', `=name=${name}`, `=ranges=${ranges}`]);
        res.json({ success: true, message: 'IP Pool সফলভাবে যুক্ত হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Render-এর সাথে ইনস্ট্যান্ট পোর্ট বাইন্ডিং
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
