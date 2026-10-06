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

// MikroTik Config
const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '103.54.37.182';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT, 10) || 1126;
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'smsbot';
const MIKROTIK_PASS = process.env.MIKROTIK_PASSWORD || '66778';

// FAZ SMS Gateway
const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'http://10.71.0.7:8080/send-sms';
const SMS_GATEWAY_TOKEN = process.env.SMS_GATEWAY_TOKEN || 'Bearer faz_secure_token_2026';

// Storage Files
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

// MikroTik Binary API Encoder / Decoder
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
                console.log(`[SOCKET TIMEOUT] Command: ${cmdWords.join(' ')}`);
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
                // Parse sentences
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
                        // End of sentence
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
            console.error(`[SOCKET ERROR] ${err.message}`);
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

// Admin Customers API
app.get('/api/admin/customers', async (req, res) => {
    try {
        let customers = loadJSON(CUSTOMERS_FILE);
        if (typeof customers !== 'object' || Array.isArray(customers)) customers = {};

        const [activeUsers, secrets] = await Promise.all([
            executeSingleCommand(['/ppp/active/print']),
            executeSingleCommand(['/ppp/secret/print'])
        ]);

        console.log(`[ROUTER SYNC] Active Users: ${activeUsers.length}, Total Secrets: ${secrets.length}`);
