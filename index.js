const express = require('express');
const net = require('net');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]:', reason);
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
                if (requestTracker[ip].count > 20) {
                    return res.status(429).json({ success: false, message: 'অতিরিক্ত অনুরোধ করা হয়েছে।' });
                }
            }
        }
        next();
    } catch (e) {
        next();
    }
}

// MikroTik Config
const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '103.54.37.182';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT, 10) || 1126;
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'smsbot';
const MIKROTIK_PASS = process.env.MIKROTIK_PASSWORD || '66778';

// SMS Gateway
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
        console.error('Save error:', e.message);
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
            } else if (loggedIn) {
                let cursor = 0;
                let currentItem = {};

                while (cursor < buffer.length) {
                    let len = 0;
                    let b = buffer[cursor];

                    if ((b & 0x80) === 0) {
                        len = b;
                        cursor += 1;
                    } else if ((b & 0xC0) === 0x80) {
                        if (cursor + 1 >= buffer.length) break;
                        len = ((b & ~0x80) << 8) | buffer[cursor + 1];
                        cursor += 2;
                    } else if ((b & 0xE0) === 0xC0) {
                        if (cursor + 2 >= buffer.length) break;
                        len = ((b & ~0xC0) << 16) | (buffer[cursor + 1] << 8) | buffer[cursor + 2];
                        cursor += 3;
                    } else if ((b & 0xF0) === 0xE0) {
                        if (cursor + 3 >= buffer.length) break;
                        len = ((b & ~0xE0) << 24) | (buffer[cursor + 1] << 16) | (buffer[cursor + 2] << 8) | buffer[cursor + 3];
                        cursor += 4;
                    } else {
                        cursor += 1;
                        continue;
                    }

                    if (len === 0) {
                        if (Object.keys(currentItem).length > 0) {
                            results.push(currentItem);
                            currentItem = {};
                        }
                        continue;
                    }

                    if (cursor + len > buffer.length) {
                        cursor -= 1;
                        break;
                    }

                    const word = buffer.slice(cursor, cursor + len).toString('utf-8');
                    cursor += len;

                    if (word.startsWith('=')) {
                        const eqIdx = word.indexOf('=', 1);
                        if (eqIdx !== -1) {
                            const k = word.substring(1, eqIdx);
                            const v = word.substring(eqIdx + 1);
                            currentItem[k] = v;
                        }
                    } else if (word === '!done' || word === '!trap') {
                        if (!finished) {
                            finished = true;
                            clearTimeout(timer);
                            client.end();
                            resolve(results);
                            return;
                        }
                    }
                }

                if (cursor > 0) {
                    buffer = buffer.slice(cursor);
                }
            }
        });

        client.on('error', () => {
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
        console.error('SMS Error:', err.message);
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

// ----------------- হটস্পট সংক্রান্ত হ্যান্ডলার -----------------
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

app.post('/api/verify-trx', rateLimiter, async (req, res) => {
    try {
        const { username, trxId } = req.body;
        if (!username || !trxId) return res.status(400).json({ success: false, message: 'ইউজার ও ট্রানজেকশন আইডি দিন।' });

        const cleanTrx = trxId.trim().toUpperCase();
        let cleanUser = username.trim().replace(/[^0-9]/g, '');
        if (cleanUser.length >= 11) cleanUser = cleanUser.slice(-11);

        const store = loadJSON(DB_FILE);
        const transaction = store[cleanTrx];

        if (!transaction) return res.status(404).json({ success: false, message: `ট্রানজেকশন আইডি (${cleanTrx}) পাওয়া যায়নি!` });
        if (transaction.used) return res.status(400).json({ success: false, message: 'এই TrxID দিয়ে আগেই একটিভ করা হয়েছে।' });

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
            message: `সফল হয়েছে! প্যাকেজ: ${profile}`,
            username: cleanUser,
            password: cleanUser,
            profile: profile
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ----------------- অটো রিচার্জ ও SMS ফরোয়ার্ড -----------------
app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = (req.query.sender || req.body.sender || req.body.from || '').trim().toLowerCase();

        if (typeof req.body === 'string') sms_body = req.body;
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

            // PPPoE অটো রিনিউয়াল
            if (referenceUser && customers[referenceUser]) {
                let cust = customers[referenceUser];
                const newExp = addDaysToDate(cust.expireDate, 30);
                cust.expireDate = newExp;
                cust.status = 'active';

                await executeSingleCommand([
                    '/ppp/secret/set',
                    `=numbers=${referenceUser}`,
                    `=profile=${cust.profile === 'Expired_Profile' ? 'FZN 30 Mbps' : cust.profile}`,
                    `=comment=Exp: ${newExp}`,
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
                return res.status(200).json({ success: true, type: 'PPPoE', user: referenceUser, expireDate: newExp });
            }

            // হটস্পট স্টোরেজ
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

// ----------------- ADMIN ROUTES -----------------

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// PPPoE প্রোফাইল তালিকা ফেচ
app.get('/api/admin/pppoe-profiles', async (req, res) => {
    try {
        const profiles = await executeSingleCommand(['/ppp/profile/print']);
        const names = profiles.map(p => p.name).filter(Boolean);
        res.json({ success: true, profiles: names });
    } catch (e) {
        res.json({ success: true, profiles: ['FZN 30 Mbps', 'FZN 50 Mbps'] });
    }
});

// গ্রাহক তালিকা
app.get('/api/admin/customers', async (req, res) => {
    try {
        let fileCustomers = loadJSON(CUSTOMERS_FILE);
        if (typeof fileCustomers !== 'object' || Array.isArray(fileCustomers)) fileCustomers = {};

        const [activeUsers, secrets] = await Promise.all([
            executeSingleCommand(['/ppp/active/print']),
            executeSingleCommand(['/ppp/secret/print'])
        ]);

        const activeMap = {};
        if (Array.isArray(activeUsers)) {
            activeUsers.forEach(u => {
                const uName = (u.name || '').trim().toLowerCase();
                if (uName) {
                    activeMap[uName] = {
                        uptime: u.uptime || 'Online',
                        address: u.address || 'N/A',
                        callerId: u['caller-id'] || ''
                    };
                }
            });
        }

        const validSecretNames = new Set();
        if (Array.isArray(secrets)) {
            secrets.forEach(sec => {
                const sName = sec.name;
                if (!sName) return;
                validSecretNames.add(sName);

                let exp = null;
                const comment = sec.comment || '';
                const m = comment.match(/Exp:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
                if (m) exp = m[1];

                const sProfile = sec.profile || 'Default';
                const sCallerId = sec['caller-id'] || '';
                const isDisabled = (sec.disabled === 'true' || sec.disabled === true);

                if (!fileCustomers[sName]) {
                    fileCustomers[sName] = {
                        name: sName,
                        username: sName,
                        password: sec.password || '1234',
                        connectionType: 'PPPoE',
                        phone: '',
                        address: '',
                        profile: sProfile,
                        bill: 500,
                        status: isDisabled ? 'suspended' : 'active',
                        expireDate: exp || '2026-11-05',
                        callerId: sCallerId
                    };
                } else {
                    fileCustomers[sName].profile = sProfile;
                    if (sCallerId) fileCustomers[sName].callerId = sCallerId;
                    if (exp) fileCustomers[sName].expireDate = exp;
                    if (isDisabled) fileCustomers[sName].status = 'suspended';
                }
            });
        }

        // ডিলিট হওয়া সিক্রেট ফিল্টার
        for (const k of Object.keys(fileCustomers)) {
            if (!validSecretNames.has(k)) {
                delete fileCustomers[k];
            }
        }
        saveJSON(CUSTOMERS_FILE, fileCustomers);

        const today = new Date().toISOString().split('T')[0];

        const list = Object.keys(fileCustomers).map(key => {
            const c = fileCustomers[key];
            const lowerUser = (c.username || '').trim().toLowerCase();
            const isOnline = !!activeMap[lowerUser];

            let liveStatus = 'offline';
            if (c.status === 'suspended' || c.profile === 'Expired_Profile') {
                liveStatus = 'suspended';
            } else if (c.expireDate && c.expireDate < today) {
                liveStatus = 'expired';
            } else if (isOnline) {
                liveStatus = 'active';
            }

            return {
                ...c,
                liveStatus,
                uptime: isOnline ? activeMap[lowerUser].uptime : 'Offline',
                ipAddress: isOnline ? activeMap[lowerUser].address : (c.ipAddress || 'N/A'),
                callerId: isOnline ? (activeMap[lowerUser].callerId || c.callerId) : (c.callerId || 'N/A')
            };
        });

        res.json({ success: true, customers: list });
    } catch (e) {
        res.json({ success: true, customers: [] });
    }
});

// কাস্টমার যোগ
app.post('/api/admin/customers/add', async (req, res) => {
    try {
        const { name, username, password, phone, address, profile, bill, expireDate } = req.body;
        const customers = loadJSON(CUSTOMERS_FILE);
        const exp = expireDate || addDaysToDate(null, 30);

        await executeSingleCommand([
            '/ppp/secret/add',
            `=name=${username}`,
            `=password=${password}`,
            `=service=pppoe`,
            `=profile=${profile}`,
            `=comment=Exp: ${exp}`
        ]);

        customers[username] = {
            name: name || username,
            username,
            password,
            phone: phone || '',
            address: address || '',
            profile,
            bill: bill || 500,
            status: 'active',
            expireDate: exp
        };

        saveJSON(CUSTOMERS_FILE, customers);
        res.json({ success: true, message: 'কাস্টমার সফলভাবে তৈরি হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// কাস্টমার এডিট ও আপডেট
app.post('/api/admin/customers/update', async (req, res) => {
    try {
        const { username, name, phone, address, profile, bill, expireDate, password } = req.body;
        const customers = loadJSON(CUSTOMERS_FILE);
        if (!customers[username]) return res.status(404).json({ success: false, message: 'কাস্টমার পাওয়া যায়নি।' });

        customers[username].name = name;
        customers[username].phone = phone;
        customers[username].address = address;
        customers[username].profile = profile;
        customers[username].bill = bill;
        customers[username].expireDate = expireDate;
        if (password) customers[username].password = password;

        const cmd = [
            '/ppp/secret/set',
            `=numbers=${username}`,
            `=profile=${profile}`,
            `=comment=Exp: ${expireDate}`
        ];
        if (password) cmd.push(`=password=${password}`);
        await executeSingleCommand(cmd);

        saveJSON(CUSTOMERS_FILE, customers);
        res.json({ success: true, message: 'কাস্টমার তথ্য আপডেট হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// কাস্টমার রিমুভ / ডিলিট
app.post('/api/admin/customers/delete', async (req, res) => {
    try {
        const { username } = req.body;
        const customers = loadJSON(CUSTOMERS_FILE);
        delete customers[username];
        saveJSON(CUSTOMERS_FILE, customers);

        await executeSingleCommand(['/ppp/secret/remove', `?name=${username}`]);
        await executeSingleCommand(['/ppp/active/remove', `?name=${username}`]);
        res.json({ success: true, message: 'কাস্টমার সম্পূর্ণ মুছে ফেলা হয়েছে।' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// কাস্টমার অ্যাকশন (রিনিউ, স্ট্যাটাস, নোটিশ)
app.post('/api/admin/customers/action', async (req, res) => {
    try {
        const { username, action, days, status } = req.body;
        const customers = loadJSON(CUSTOMERS_FILE);
        const cust = customers[username];
        if (!cust) return res.status(404).json({ success: false, message: 'গ্রাহক পাওয়া যায়নি।' });

        if (action === 'renew') {
            const addDays = parseInt(days, 10) || 30;
            const newExp = addDaysToDate(cust.expireDate, addDays);
            cust.expireDate = newExp;
            cust.status = 'active';

            await executeSingleCommand([
                '/ppp/secret/set',
                `=numbers=${username}`,
                `=profile=${cust.profile === 'Expired_Profile' ? 'FZN 30 Mbps' : cust.profile}`,
                `=disabled=no`,
                `=comment=Exp: ${newExp}`
            ]);
            await executeSingleCommand(['/ppp/active/remove', `?name=${username}`]);

            if (cust.phone) {
                await sendGatewaySMS(cust.phone, `Prio Grahok (User: ${username}), internet line renew kora hoyeche. Notun meyad: ${newExp} porjonto.`);
            }
        } else if (action === 'status') {
            cust.status = status;
            if (status === 'suspended') {
                await executeSingleCommand(['/ppp/secret/set', `=numbers=${username}`, `=profile=Expired_Profile`]);
                await executeSingleCommand(['/ppp/active/remove', `?name=${username}`]);
            } else {
                await executeSingleCommand(['/ppp/secret/set', `=numbers=${username}`, `=profile=${cust.profile === 'Expired_Profile' ? 'FZN 30 Mbps' : cust.profile}`, `=disabled=no`]);
            }
        } else if (action === 'send-notice') {
            if (!cust.phone) return res.status(400).json({ success: false, message: 'ফোন নম্বর নেই।' });
            await sendGatewaySMS(cust.phone, `Prio Grahok (User: ${username}), apnar meyad shesh hoyeche. Shongjog chalu rakhte bill porishodh korun.`);
            return res.json({ success: true, message: 'এসএমএস নোটিশ পাঠানো হয়েছে!' });
        }

        saveJSON(CUSTOMERS_FILE, customers);
        res.json({ success: true, message: 'অ্যাকশন সফল হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// আইপি পুল
app.get('/api/admin/pools', async (req, res) => {
    try {
        const pools = await executeSingleCommand(['/ip/pool/print']);
        res.json({ success: true, pools: Array.isArray(pools) ? pools : [] });
    } catch (e) {
        res.json({ success: true, pools: [] });
    }
});

app.post('/api/admin/pools/add', async (req, res) => {
    try {
        const { name, ranges } = req.body;
        if (!name || !ranges) return res.status(400).json({ success: false, message: 'নাম ও রেঞ্জ আবশ্যক।' });
        await executeSingleCommand(['/ip/pool/add', `=name=${name}`, `=ranges=${ranges}`]);
        res.json({ success: true, message: 'IP Pool তৈরি সফল হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
