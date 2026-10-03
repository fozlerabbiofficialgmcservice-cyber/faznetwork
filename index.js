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

// মাইক্রোটিক লগইন পেজ থেকে AJAX রিকোয়েস্ট আসার জন্য CORS অনুমতি দেওয়া হলো
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
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
    '10': 'Profile - 1Hour',
    '15': 'Profile - 12Hour',
    '20': 'Profile - 1Day',
    '40': 'Profile - 3Day',
    '60': 'Profile - 7Day',
    '90': 'Profile - 15Day',
    '150': 'Profile - 30Day',
    '200': 'Profile - 100GB',
    '350': 'Profile - 300GB'
};

const DB_FILE = path.join(__dirname, 'transactions.json');

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

// একক কমান্ড নির্বাহক - প্রতি কমান্ডের জন্য আলাদা ও নির্ভরযোগ্য কানেকশন
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
                // লগইন শেষ, এবার কাঙ্ক্ষিত কমান্ড পাঠানো
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

// ইউজার তৈরি
async function ensureUser(username, comment = '') {
    console.log(`[USER MANAGER] Ensuring user: ${username}`);
    const cmd = ['/user-manager/user/add', `=name=${username}`, `=password=${username}`, `=group=Hotspot`];
    if (comment) cmd.push(`=comment=${comment}`);
    await executeSingleCommand(cmd);
}

// প্রোফাইল যুক্ত করা
async function attachProfile(username, profileName) {
    console.log(`[USER MANAGER] Attaching profile: ${username} -> ${profileName}`);
    // RouterOS v7 User Manager কমান্ড
    const cmd = ['/user-manager/user-profile/add', `=user=${username}`, `=profile=${profileName}`];
    return await executeSingleCommand(cmd);
}

// কমেন্ট আপডেট করা
async function updateUserComment(username, comment) {
    const cmd = ['/user-manager/user/set', `*${username}`, `=comment=${comment}`];
    await executeSingleCommand(cmd);
}

app.get('/', (req, res) => {
    return res.status(200).send('FAZ NETWORK Hotspot API is Running!');
});

// ১. SMS Webhook (MacroDroid থেকে কল হবে)
app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = req.query.sender || req.body.sender || req.body.from || '';

        if (typeof req.body === 'string') sms_body = req.body;
        console.log(`[SMS RECEIVED]: ${sms_body}`);

        const trxMatch = sms_body.match(/TrxID\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

        const amountMatch = sms_body.match(/(?:Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])).toString() : null;

        let detectedPhone = null;
        const phoneMatch = sms_body.match(/(?:from|sender)\s*[:]?\s*(?:\+?88)?(01[3-9][0-9]{8})/i);
        if (phoneMatch && phoneMatch[1]) {
            detectedPhone = phoneMatch[1];
        } else if (sender) {
            let clean = sender.replace(/[^0-9]/g, '');
            if (clean.length >= 11) detectedPhone = clean.slice(-11);
        }

        // SMS আসার সাথে সাথে ইউজার ক্রিয়েট
        if (detectedPhone) {
            await ensureUser(detectedPhone, `Received Tk ${amount || '0'}`);
        }

        // TrxID সেভ রাখা
        if (trxId && amount) {
            saveTransaction(trxId, {
                amount: amount,
                phone: detectedPhone || '',
                used: false,
                receivedAt: Date.now()
            });
            console.log(`[TRX SAVED] TrxID: ${trxId} | Amount: ${amount}`);
        }

        return res.status(200).json({ success: true, trxId, amount, user: detectedPhone });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ২. মাইক্রোটিক হটস্পট লগইন পেজ থেকে TrxID ভেরিফিকেশন API
app.post('/api/verify-trx', async (req, res) => {
    try {
        const { username, trxId } = req.body;

        if (!username || !trxId) {
            return res.status(400).json({ success: false, message: 'ইউজার আইডি ও TrxID দিন।' });
        }

        const cleanTrx = trxId.trim().toUpperCase();
        const cleanUser = username.trim();

        const store = loadTransactions();
        const transaction = store[cleanTrx];

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: `TrxID (${cleanTrx}) পাওয়া যায়নি! টাকা পাঠানো হয়েছে কিনা নিশ্চিত করুন।`
            });
        }

        if (transaction.used) {
            return res.status(400).json({
                success: false,
                message: 'এই TrxID দিয়ে আগেই প্যাকেজ নেওয়া হয়েছে।'
            });
        }

        const profile = PRICE_PROFILE_MAP[transaction.amount] || 'Profile - 1Hour';
        const commentText = `TrxID: ${cleanTrx} | Tk: ${transaction.amount}`;

        // ১. নিশ্চিত করা ইউজার আছে কি না
        await ensureUser(cleanUser, commentText);

        // ২. ইউজারের কমেন্ট আপডেট
        await updateUserComment(cleanUser, commentText);

        // ৩. ইউজারের প্রোফাইল যোগ করা
        await attachProfile(cleanUser, profile);

        transaction.used = true;
        transaction.activatedUser = cleanUser;
        saveTransaction(cleanTrx, transaction);

        return res.status(200).json({
            success: true,
            message: `সফল হয়েছে! প্যাকেজ: ${profile}`,
            username: cleanUser,
            password: cleanUser, // ইউজারনেম ও পাসওয়ার্ড একই রাখা হয়েছে
            profile: profile
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
