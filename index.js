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

// ফাইল পাথ
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
        }, 5000);

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
                        currentItem[parts[0]] = parts.slice(1).join('=');
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
        await axios.post(SMS_GATEWAY_URL, 'to=' + encodeURIComponent(toPhone) + '&message=' + encodeURIComponent(message), {
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
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// কাস্টমার তালিকা (মাইক্রোটিক + লোকাল ক্যাশ)
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
                const name = u.name || u['=name'];
                if (name) {
                    activeMap[name] = {
                        uptime: u.uptime || u['=uptime'] || 'Online',
                        address: u.address || u['=address'] || 'N/A',
                        callerId: u['caller-id'] || u['=caller-id'] || ''
                    };
                }
            });
        }

        if (Array.isArray(secrets)) {
            secrets.forEach(sec => {
                const sName = sec.name || sec['=name'];
                if (!sName) return;

                let exp = null;
                const comment = sec.comment || sec['=comment'] || '';
                const m = comment.match(/Exp:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
                if (m) exp = m[1];

                const sProfile = sec.profile || sec['=profile'] || 'Default';
                const sCallerId = sec['caller-id'] || sec['=caller-id'] || '';
                const isDisabled = (sec.disabled === 'true' || sec['=disabled'] === 'true');

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
