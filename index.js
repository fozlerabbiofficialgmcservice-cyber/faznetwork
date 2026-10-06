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
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// MikroTik কানেকশন ডিটেইলস
const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '103.54.37.182';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT) || 1126;
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'smsbot';
const MIKROTIK_PASS = process.env.MIKROTIK_PASSWORD || '66778';

// প্যাকেজ প্রাইস ম্যাপিং
const PACKAGE_PRICE_MAP = {
    'FZN 10 Mbps': 400,
    'FZN 15 Mbps': 500,
    'FZN 20 Mbps': 600,
    'FZN 25 Mbps': 700,
    'FZN 30 Mbps': 800,
    'FZN 40 Mbps': 1000,
    'FZN 50 Mbps': 1200
};

// JSON ফাইল পাথসমূহ (পূর্বের কোনো ফাইল বা ডেটা মুছে যাবে না)
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

// ======================== MIKROTIK PROTOCOL HELPERS ========================
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
                            if (item[0] === '!re') {
                                const obj = {};
                                for (let i = 1; i < item.length; i++) {
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
        }, 7000);

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

        client.on('error', () => {
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

// বাইটকে রিডেবল আকারে রূপান্তর (MB / GB)
function formatBytes(bytes) {
    const b = parseInt(bytes) || 0;
    if (b === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ======================== API ROUTES ========================

// ================= 1. DASHBOARD OVERVIEW =================
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [pppActive, hsActive, pppSecrets, hsUsers] = await Promise.all([
            runMikrotikApi(['/ppp/active/print']),
            runMikrotikApi(['/ip/hotspot/active/print']),
            runMikrotikApi(['/ppp/secret/print']),
            runMikrotikApi(['/ip/hotspot/user/print'])
        ]);

        res.json({
            success: true,
            stats: {
                totalCustomers: (pppSecrets || []).length,
                onlinePppoe: (pppActive || []).length,
                totalHotspotUsers: (hsUsers || []).length,
                onlineHotspot: (hsActive || []).length
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ================= 2. HOTSPOT SUITE (ALL SUB-MENUS) =================
// 2.1 All Users
app.get('/api/hotspot/users', async (req, res) => {
    try {
        const users = await runMikrotikApi(['/ip/hotspot/user/print']);
        const formatted = (users || []).map(u => ({
            id: u['.id'],
            server: u.server || 'all',
            name: u.name || '',
            username: u.name || '',
            profile: u.profile || 'default',
            uptime: u.uptime || '0s',
            limitUptime: u['limit-uptime'] || 'Unlimited',
            bytesIn: formatBytes(u['bytes-in']),
            bytesOut: formatBytes(u['bytes-out']),
            comment: u.comment || '',
            disabled: u.disabled === 'true' || u.disabled === 'yes'
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json([]);
    }
});

// 2.2 Add Hotspot User
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
        res.json({ success: result, message: result ? 'User created!' : 'Failed to create user on router' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2.3 Delete Hotspot User
app.delete('/api/hotspot/users/:name', async (req, res) => {
    try {
        const username = req.params.name;
        const users = await runMikrotikApi(['/ip/hotspot/user/print', `?name=${username}`]);
        if (!users || users.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        const id = users[0]['.id'];
        const result = await executeSingleCommand(['/ip/hotspot/user/remove', `=.id=${id}`]);
        res.json({ success: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2.4 Active & Online Hotspot Users
app.get('/api/hotspot/active', async (req, res) => {
    try {
        const activeUsers = await runMikrotikApi(['/ip/hotspot/active/print']);
        const formatted = (activeUsers || []).map(u => ({
            id: u['.id'],
            server: u.server || '',
            user: u.user || '',
            address: u.address || '',
            macAddress: u['mac-address'] || '',
            uptime: u.uptime || '',
            bytesIn: formatBytes(u['bytes-in']),
            bytesOut: formatBytes(u['bytes-out'])
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json([]);
    }
});

// 2.5 Hotspot Profiles
app.get('/api/hotspot/profiles', async (req, res) => {
    try {
        const profiles = await runMikrotikApi(['/ip/hotspot/user/profile/print']);
        res.json(profiles || []);
    } catch (err) {
        res.status(500).json([]);
    }
});

// 2.6 Hotspot Server Profiles
app.get('/api/hotspot/server-profiles', async (req, res) => {
    try {
        const serverProfiles = await runMikrotikApi(['/ip/hotspot/profile/print']);
        res.json(serverProfiles || []);
    } catch (err) {
        res.status(500).json([]);
    }
});

// ================= 3. CUSTOMER & PPPOE (ALL SUB-MENUS) =================
// 3.1 All Customers + Secret Info
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

        // লোকাল ডেটাবেজে অতিরিক্ত কেউ থাকলে যুক্ত করা
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

// 3.2 Add Customer (PPPoE + Local DB)
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

// ================= 4. CORE SYSTEM (POOLS, PACKAGES, DEVICES) =================
// 4.1 PPP Profiles / Packages
app.get('/api/packages', async (req, res) => {
    try {
        const profiles = await runMikrotikApi(['/ppp/profile/print']);
        let packageList = [];
        if (profiles && profiles.length > 0) {
            packageList = profiles
                .map(p => p.name)
                .filter(name => name && !['default', 'default-encryption'].includes(name.toLowerCase()))
                .map(name => ({
                    name: name,
                    price: PACKAGE_PRICE_MAP[name] || ''
                }));
        }

        if (packageList.length === 0) {
            packageList = [
                { name: 'FZN 10 Mbps', price: 400 },
                { name: 'FZN 15 Mbps', price: 500 },
                { name: 'FZN 20 Mbps', price: 600 },
                { name: 'FZN 30 Mbps', price: 800 }
            ];
        }

        res.json({ success: true, packages: packageList });
    } catch (e) {
        res.json({ success: true, packages: [{ name: 'FZN 10 Mbps', price: 400 }] });
    }
});

// 4.2 IP Pools
app.get('/api/core/ip-pools', async (req, res) => {
    try {
        const pools = await runMikrotikApi(['/ip/pool/print']);
        res.json(pools || []);
    } catch (e) {
        res.status(500).json([]);
    }
});

// 4.3 Interfaces / Traffic Monitor
app.get('/api/core/interfaces', async (req, res) => {
    try {
        const interfaces = await runMikrotikApi(['/interface/print']);
        res.json(interfaces || []);
    } catch (e) {
        res.status(500).json([]);
    }
});

// ================= 5. PAYMENTS & TRANSACTIONS =================
app.get('/api/payments', (req, res) => {
    res.json(loadJson(DB_FILE, []));
});

app.post('/api/payments', (req, res) => {
    const list = loadJson(DB_FILE, []);
    const record = Object.assign({ id: Date.now(), date: new Date().toISOString() }, req.body);
    list.unshift(record);
    saveJson(DB_FILE, list);
    res.json({ success: true, payment: record });
});

// ================= 6. EXPENSES, SUPPORT & HR =================
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

// ================= 7. SETTINGS =================
app.get('/api/settings', (req, res) => {
    res.json(loadJson(SETTINGS_FILE, { smsGatewayUrl: '' }));
});

app.post('/api/settings', (req, res) => {
    saveJson(SETTINGS_FILE, { smsGatewayUrl: (req.body.smsGatewayUrl || '').trim() });
    res.json({ success: true });
});

// সার্ভার স্টার্ট
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
