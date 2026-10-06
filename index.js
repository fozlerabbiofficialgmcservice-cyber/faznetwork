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
                    message: 'Too many requests. Please try again after 1 minute.'
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
                res.on('data', chunk => { resData += chunk; });
                res.on('end', () => {
                    resolve({ success: true, response: resData });
                });
            });

            req.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });

            req.write(postData);
            req.end();
        } catch (err) {
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

// মাইক্রোটিক কমান্ড চালানোর ফাংশন
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

// মাইক্রোটিক থেকে তথ্য পড়ার ফাংশন (বাক্য অনুযায়ী অবজেক্টে কনভার্ট)
function queryMikrotikRecords(cmdWords) {
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
        }, 8000);

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
                    clearTimeout(timer);
                    client.end();

                    // !re রেসপন্স থেকে রেকর্ড এক্সট্র্যাক্ট করা
                    const rawRecords = text.split('!re').slice(1);
                    const records = [];

                    for (const raw of rawRecords) {
                        const item = {};
                        const lines = raw.split(/\x00|\n|\r/);
                        for (const line of lines) {
                            if (line.startsWith('=')) {
                                const eqIdx = line.indexOf('=', 1);
                                if (eqIdx > 1) {
                                    const key = line.substring(1, eqIdx);
                                    const val = line.substring(eqIdx + 1);
                                    item[key] = val;
                                }
                            }
                        }
                        if (Object.keys(item).length > 0) records.push(item);
                    }
                    resolve(records);
                }
            }
        });

        client.on('error', (err) => {
            console.error('[ROUTER QUERY ERROR]:', err.message);
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

// ======================== API ROUTES ========================

// ১. প্যাকেজ লিস্ট (MikroTik PPPoE Profiles)
app.get('/api/packages', async (req, res) => {
    try {
        const profiles = await queryMikrotikRecords(['/ppp/profile/print']);
        
        // ডিফল্ট বা সিস্টেম প্রোফাইল ছাড়া প্যাকেজ তালিকা ফিল্টার
        let packageNames = profiles
            .map(p => p.name)
            .filter(name => name && !['default', 'default-encryption'].includes(name.toLowerCase()));

        if (packageNames.length === 0) {
            packageNames = ['5Mbps', '10Mbps', '15Mbps', '20Mbps', '30Mbps'];
        }

        res.json({ success: true, packages: packageNames });
    } catch (e) {
        res.json({ success: true, packages: ['5Mbps', '10Mbps', '15Mbps', '20Mbps'] });
    }
});

// ২. সকল কাস্টমার তালিকা (MikroTik PPPoE Secrets + Local DB)
app.get('/api/customers', async (req, res) => {
    try {
        const pppSecrets = await queryMikrotikRecords(['/ppp/secret/print']);
        const localCustomers = loadJson(CUSTOMERS_FILE, []);

        const customersMap = {};
        for (const cust of localCustomers) {
            customersMap[cust.username] = cust;
        }

        const combined = pppSecrets.map(secret => {
            const username = secret.name;
            const extra = customersMap[username] || {};
            const isDisabled = secret.disabled === 'true' || secret.disabled === 'yes';

            // কমেন্ট থেকে এক্সপায়ারি বের করা (যদি থাকে)
            let expiry = extra.expiryDate || '';
            if (!expiry && secret.comment) {
                const match = secret.comment.match(/Exp:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
                if (match) expiry = match[1];
            }

            return {
                username: username,
                name: extra.fullName || extra.name || username,
                phone: extra.phoneNumber || extra.phone || '',
                package: secret.profile || extra.package || 'Default',
                service: secret.service || 'pppoe',
                status: isDisabled ? 'Disabled' : 'Active',
                expiryDate: expiry || extra.expiryDate || 'N/A',
                address: extra.fullAddress || extra.address || '',
                comment: secret.comment || ''
            };
        });

        // যদি লোকাল ফাইলে এমন কোনো কাস্টমার থাকে যা রাউটারে নেই
        for (const localCust of localCustomers) {
            if (!combined.some(c => c.username === localCust.username)) {
                combined.push(localCust);
            }
        }

        res.json(combined);
    } catch (err) {
        console.error('Customer fetch error:', err);
        const fallback = loadJson(CUSTOMERS_FILE, []);
        res.json(fallback);
    }
});

// ৩. নতুন PPPoE কাস্টমার যুক্ত / মেয়াদ সহ মাইক্রোটিকে কনফিগার করা
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
            return res.status(400).json({ success: false, message: 'Username and Password are required.' });
        }

        // এক্সপায়ারি ডেট গণনা
        let calculatedExpiry = '';
        if (customExpiryDate) {
            calculatedExpiry = customExpiryDate;
        } else {
            const now = new Date();
            let monthsToAdd = 1;
            if (billingDuration === '3_months') monthsToAdd = 3;
            else if (billingDuration === '6_months') monthsToAdd = 6;
            else if (billingDuration === '12_months') monthsToAdd = 12;

            now.setMonth(now.getMonth() + monthsToAdd);
            calculatedExpiry = now.toISOString().split('T')[0];
        }

        const commentText = `Exp: ${calculatedExpiry} | Phone: ${phoneNumber || 'N/A'} | Added: ${new Date().toISOString().split('T')[0]}`;

        // MikroTik এ PPPoE Secret তৈরি / আপডেট
        const cmd = [
            '/ppp/secret/add',
            `=name=${username.trim()}`,
            `=password=${password.trim()}`,
            `=service=pppoe`,
            `=profile=${pkg || 'default'}`,
            `=comment=${commentText}`
        ];

        let created = await executeSingleCommand(cmd);

        // ইউজার আগে থেকেই থাকলে আপডেট করা হবে
        if (!created) {
            const updateCmd = [
                '/ppp/secret/set',
                `=numbers=${username.trim()}`,
                `=password=${password.trim()}`,
                `=profile=${pkg || 'default'}`,
                `=comment=${commentText}`,
                `=disabled=no`
            ];
            await executeSingleCommand(updateCmd);
        }

        // লোকাল ডেটাবেজে বিস্তারিত সেভ
        const customers = loadJson(CUSTOMERS_FILE, []);
        const idx = customers.findIndex(c => c.username === username.trim());
        const customerRecord = {
            username: username.trim(),
            password: password.trim(),
            name: fullName || username.trim(),
            phone: phoneNumber || '',
            package: pkg || 'default',
            status: 'Active',
            billingDuration: billingDuration || '1_month',
            expiryDate: calculatedExpiry,
            address: fullAddress || '',
            nidPassport: nidPassport || '',
            createdAt: new Date().toLocaleDateString('en-GB')
        };

        if (idx !== -1) {
            customers[idx] = Object.assign({}, customers[idx], customerRecord);
        } else {
            customers.unshift(customerRecord);
        }

        saveJson(CUSTOMERS_FILE, customers);

        res.json({
            success: true,
            message: 'PPPoE Customer created successfully in MikroTik.',
            expiryDate: calculatedExpiry
        });
    } catch (err) {
        console.error('Customer add error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ৪. নির্দিষ্ট কাস্টমারের তথ্য
app.get('/api/customer/:username', (req, res) => {
    const customers = loadJson(CUSTOMERS_FILE, []);
    const customer = customers.find(c => c.username === req.params.username);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });
    res.json({ success: true, customer });
});

// ৫. সেটিংস API
app.get('/api/settings', (req, res) => {
    const settings = loadJson(SETTINGS_FILE, { smsGatewayUrl: '' });
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const { smsGatewayUrl } = req.body;
    saveJson(SETTINGS_FILE, { smsGatewayUrl: (smsGatewayUrl || '').trim() });
    res.json({ success: true, message: 'Settings saved successfully.' });
});

// ৬. SMS API
app.post('/api/send-sms', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, message: 'Phone and message required.' });

    const result = await triggerPhoneSms(phone, message);
    if (result.success) {
        res.json({ success: true, message: 'SMS sent successfully.' });
    } else {
        res.status(500).json({ success: false, message: 'Failed to send SMS.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
