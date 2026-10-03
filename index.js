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

// মাইক্রোটিক লগইন পেজ থেকে AJAX রিকোয়েস্ট আসার জন্য CORS অনুমতি
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use


// index.js এর যেখানে app.use(...) শুরু হয়েছে তার ঠিক নিচে যোগ করুন:
const adminRoutes = require('./admin-routes');
app.use('/api/admin', adminRoutes);




(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ফ্রড ও ব্রুট-ফোর্স রোধে সিম্পল মেমোরি রেট লিমিটার (প্রতি মিনিটে সর্বোচ্চ ১০টি ট্রাই)
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

const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '103.54.37.182';
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT) || 1126;
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'smsbot';
const MIKROTIK_PASS = process.env.MIKROTIK_PASSWORD || '66778';

// মাইক্রোটিকের হুবহু প্রোফাইল নাম
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

// ইউজার আগে থেকে থাকলে যেন এরর ছাড়া এক্সিকিউট হয়
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

// প্রোফাইল যুক্ত/রিনিউ করা (নতুন ও পুরাতন উভয় ক্ষেত্রে কাজ করবে)
async function attachProfile(username, profileName) {
    console.log(`[USER MANAGER] Attaching/Renewing profile: ${username} -> ${profileName}`);
    const cmd = [
        '/user-manager/user-profile/add',
        `=user=${username}`,
        `=profile=${profileName}`
    ];
    return await executeSingleCommand(cmd);
}

// ইউজারের কমেন্ট ও রিচার্জ হিস্ট্রি আপডেট
async function updateUserComment(username, comment) {
    const cmd = [
        '/user-manager/user/set',
        `=numbers=${username}`,
        `=comment=${comment}`
    ];
    await executeSingleCommand(cmd);
}

app.get('/', (req, res) => {
    return res.status(200).send('FAZ NETWORK Hotspot API is Running!');
});

// ১. SMS Webhook (MacroDroid থেকে এসএমএস গ্রহণ এবং কঠোর সেন্ডার ফিল্টারিং)
app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = (req.query.sender || req.body.sender || req.body.from || '').trim().toLowerCase();

        if (typeof req.body === 'string') sms_body = req.body;
        console.log(`[INCOMING SMS RAW] Sender: "${sender}" | Body: "${sms_body}"`);

        // ১. সেন্ডার তথ্য না থাকলে বাতিল
        if (!sender) {
            console.warn('[BLOCKED] Sender information is missing.');
            return res.status(400).json({ success: false, message: 'Sender information missing.' });
        }

        // ২. সেন্ডার শুধুমাত্র বিকাশ বা নগদের অফিশিয়াল নাম/শর্টকোড কিনা কঠোরভাবে যাচাই
        const isBkashSender = sender.includes('bkash') || sender.includes('16247');
        const isNagadSender = sender.includes('nagad') || sender.includes('16167');

        if (!isBkashSender && !isNagadSender) {
            console.warn(`[FRAUD ALERT] Blocked fake SMS from non-official sender: ${sender}`);
            return res.status(403).json({
                success: false,
                message: 'Rejected: SMS is not from official bKash or Nagad sender.'
            });
        }

        // ৩. মেসেজ বডির অফিসিয়াল কি-ওয়ার্ড প্যাটার্ন যাচাই (ক্যাশ ইন বা পেমেন্ট রিসিভ)
        const isBkashFormat = /You have received (?:Tk|deposit)|Cash In Tk/i.test(sms_body);
        const isNagadFormat = /Money Received|Cash In amount/i.test(sms_body);

        if (!isBkashFormat && !isNagadFormat) {
            console.warn('[REJECTED] SMS does not match official payment confirmation pattern.');
            return res.status(400).json({ success: false, message: 'Invalid payment SMS format.' });
        }

        const trxMatch = sms_body.match(/TrxID\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

        const amountMatch = sms_body.match(/(?:Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])).toString() : null;

        let detectedPhone = null;
        // মেসেজ থেকে প্রেরক কাস্টমারের ফোন নম্বর শনাক্তকরণ
        const phoneMatch = sms_body.match(/(?:from|sender|number|fee\s*tk\s*[0-9.]+\s*from)\s*[:]?\s*(?:\+?88)?(01[3-9][0-9]{8})/i);
        if (phoneMatch && phoneMatch[1]) {
            detectedPhone = phoneMatch[1].trim();
        }

        if (trxId && amount) {
            saveTransaction(trxId, {
                amount: amount,
                phone: detectedPhone || '',
                used: false,
                receivedAt: Date.now()
            });
            console.log(`[TRX SAVED] TrxID: ${trxId} | Amount: ${amount} | Sender Phone: ${detectedPhone || 'N/A'}`);
            return res.status(200).json({ success: true, trxId, amount, user: detectedPhone });
        } else {
            console.warn('[REJECTED] Incomplete transaction data in SMS.');
            return res.status(400).json({ success: false, message: 'Invalid SMS content, TrxID/Amount not found.' });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ২. মাইক্রোটিক হটস্পট লগইন পেজ থেকে TrxID ভেরিফিকেশন API
app.post('/api/verify-trx', rateLimiter, async (req, res) => {
    try {
        const { username, trxId } = req.body;

        if (!username || !trxId) {
            return res.status(400).json({ success: false, message: 'ইউজার আইডি ও TrxID দিন।' });
        }

        const cleanTrx = trxId.trim().toUpperCase();
        let cleanUser = username.trim().replace(/[^0-9]/g, '');
        if (cleanUser.length >= 11) cleanUser = cleanUser.slice(-11);

        const store = loadTransactions();
        const transaction = store[cleanTrx];

        // ১. ট্রানজেকশন ডাটাবেজে আছে কি না
        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: `TrxID (${cleanTrx}) পাওয়া যায়নি! সঠিক TrxID দিন অথবা পেমেন্ট সম্পন্ন হয়েছে কি না নিশ্চিত করুন।`
            });
        }

        // ২. আগেই ব্যবহার করা হয়েছে কি না (Replay Attack রোধ)
        if (transaction.used) {
            return res.status(400).json({
                success: false,
                message: 'এই TrxID দিয়ে আগেই প্যাকেজ সক্রিয় করা হয়েছে।'
            });
        }

        // ৩. মোবাইল নম্বর ম্যাচিং (অন্যের TrxID চুরি রোধ)
        if (transaction.phone) {
            let expectedPhone = transaction.phone.trim().replace(/[^0-9]/g, '').slice(-11);
            if (expectedPhone && expectedPhone !== cleanUser) {
                return res.status(403).json({
                    success: false,
                    message: 'ভুল মোবাইল নম্বর! যে নম্বর থেকে টাকা পাঠিয়েছেন সেই নম্বরটি প্রদান করুন।'
                });
            }
        }

        const profile = PRICE_PROFILE_MAP[transaction.amount] || 'Profile-1Hour';
        const commentText = `TrxID: ${cleanTrx} | Tk: ${transaction.amount} | Date: ${new Date().toLocaleDateString('en-GB')}`;

        // ইউজার তৈরি নিশ্চিত করা (আগে থেকে থাকলে কোনো এরর হবে না)
        await ensureUser(cleanUser, commentText);

        // প্রোফাইল যুক্ত/রিনিউ করা (নতুন অথবা মেয়াদোত্তীর্ণ উভয় ইউজারে কাজ করবে)
        await attachProfile(cleanUser, profile);

        // ইউজারের কমেন্ট আপডেট করা
        await updateUserComment(cleanUser, commentText);

        // TrxID লক করা
        transaction.used = true;
        transaction.activatedUser = cleanUser;
        transaction.usedAt = Date.now();
        saveTransaction(cleanTrx, transaction);

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

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
