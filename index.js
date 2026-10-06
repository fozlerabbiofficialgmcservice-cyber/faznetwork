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
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

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

// ----------------- ROUTES -----------------

app.get('/', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'admin.html'))) {
        return res.sendFile(path.join(__dirname, 'admin.html'));
    }
    return res.sendFile(path.join(__dirname, 'index.html'));
});

// কাস্টমার তালিকা API
app.get('/api/admin/customers', async (req, res) => {
    try {
        let customers = loadJSON(CUSTOMERS_FILE);
        if (typeof customers !== 'object' || Array.isArray(customers)) customers = {};

        const [activeUsers, secrets] = await Promise.all([
            executeSingleCommand(['/ppp/active/print']),
            executeSingleCommand(['/ppp/secret/print'])
        ]);

        const activeMap = {};
        if (Array.isArray(activeUsers)) {
            activeUsers.forEach(u => {
                const name = u.name;
                if (name) {
                    activeMap[name] = {
                        uptime: u.uptime || 'Online',
                        address: u.address || 'N/A',
                        callerId: u['caller-id'] || ''
                    };
                }
            });
        }

        if (Array.isArray(secrets)) {
            secrets.forEach(sec => {
                const sName = sec.name;
                if (!sName) return;

                let exp = null;
                const comment = sec.comment || '';
                const m = comment.match(/Exp:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
                if (m) exp = m[1];

                const sProfile = sec.profile || 'Default';
                const sCallerId = sec['caller-id'] || '';
                const isDisabled = (sec.disabled === 'true' || sec.disabled === true);

                if (!customers[sName]) {
                    customers[sName] = {
                        name: sName,
                        username: sName,
                        connectionType: 'PPPoE',
                        phone: '',
                        profile: sProfile,
                        bill: 500,
                        status: isDisabled ? 'suspended' : 'active',
                        expireDate: exp || '2026-11-05',
                        callerId: sCallerId
                    };
                } else {
                    customers[sName].profile = sProfile;
                    if (sCallerId) customers[sName].callerId = sCallerId;
                    if (exp) customers[sName].expireDate = exp;
                    if (isDisabled) customers[sName].status = 'suspended';
                }
            });
            saveJSON(CUSTOMERS_FILE, customers);
        }

        const today = new Date().toISOString().split('T')[0];

        const list = Object.keys(customers).map(key => {
            const c = customers[key];
            let liveStatus = 'offline';
            if (c.status === 'suspended' || c.profile === 'Expired_Profile') {
                liveStatus = 'suspended';
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
        console.error('Customers API error:', e.message);
        res.json({ success: true, customers: [] });
    }
});

// আইপি পুল API
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
        if (!name || !ranges) return res.status(400).json({ success: false, message: 'Name and range required.' });
        await executeSingleCommand(['/ip/pool/add', `=name=${name}`, `=ranges=${ranges}`]);
        res.json({ success: true, message: 'IP Pool তৈরি সফল হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// কাস্টমার অ্যাকশন API
app.post('/api/admin/customers/action', async (req, res) => {
    try {
        const { username, action, days, status } = req.body;
        const customers = loadJSON(CUSTOMERS_FILE);
        const cust = customers[username];
        if (!cust) return res.status(404).json({ success: false, message: 'Customer পাওয়া যায়নি।' });

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
            if (!cust.phone) return res.status(400).json({ success: false, message: 'Phone number নেই।' });
            await sendGatewaySMS(cust.phone, `Prio Grahok (User: ${username}), apnar meyad shesh hoyeche. Shongjog chalu rakhte bill porishodh korun.`);
            return res.json({ success: true, message: 'SMS notice পাঠানো হয়েছে!' });
        }

        saveJSON(CUSTOMERS_FILE, customers);
        res.json({ success: true, message: 'Action সফল হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// কাস্টমার যোগ API
app.post('/api/admin/customers/add', async (req, res) => {
    try {
        const { name, username, password, phone, profile, bill, expireDate } = req.body;
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
            phone: phone || '',
            profile,
            bill: bill || 500,
            status: 'active',
            expireDate: exp
        };

        saveJSON(CUSTOMERS_FILE, customers);
        res.json({ success: true, message: 'Customer যোগ করা হয়েছে!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// সার্ভার লিসেনিং
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
