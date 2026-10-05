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

// মাইক্রোটিক লগইন পেজ ও বিভিন্ন ডিভাইস থেকে AJAX রিকোয়েস্টের জন্য CORS হেডার
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ফ্রড ও ব্রুট-ফোর্স রোধে সিম্পল মেমোরি রেট লিমিটার (প্রতি মিনিটে সর্বোচ্চ ১০টি রিকোয়েস্ট)
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
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'render';
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

// ইউজার নিশ্চিত করা: Username = MAC এবং Password = Phone Number
async function ensureUser(username, password, comment = '') {
    console.log(`[USER MANAGER] Ensuring user: ${username} (Pass: ${password})`);
    
    // প্রথমে বিদ্যমান ইউজারের পাসওয়ার্ড ও কমেন্ট আপডেট করার চেষ্টা (যদি আগে থেকেই ম্যাক থাকে)
    const setCmd = [
        '/user-manager/user/set',
        `=numbers=${username}`,
        `=password=${password}`
    ];
    if (comment) setCmd.push(`=comment=${comment}`);
    const updated = await executeSingleCommand(setCmd);

    // যদি ইউজার আগে না থাকে, তবে নতুন তৈরি করা
    if (!updated) {
        const addCmd = [
            '/user-manager/user/add',
            `=name=${username}`,
            `=password=${password}`,
            `=group=Hotspot`
        ];
        if (comment) addCmd.push(`=comment=${comment}`);
        await executeSingleCommand(addCmd);
    }
}

// প্রোফাইল যুক্ত বা রিনিউ করা
async function attachProfile(username, profileName) {
    console.log(`[USER MANAGER] Attaching/Renewing profile: ${username} -> ${profileName}`);
    const cmd = [
        '/user-manager/user-profile/add',
        `=user=${username}`,
        `=profile=${profileName}`
    ];
    return await executeSingleCommand(cmd);
}

// ইউজারের কমেন্ট আপডেট
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

// ১. SMS Webhook (বিকাশের TrxID এবং নগদের TxnID উভয়ই সাপোর্ট করবে)
app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = (req.query.sender || req.body.sender || req.body.from || '').trim().toLowerCase();

        if (typeof req.body === 'string') sms_body = req.body;
        console.log(`[INCOMING SMS RAW] Sender: "${sender}" | Body: "${sms_body}"`);

        // ১. সেন্ডার ফিল্টারিং
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

        // ২. বিকাশ ও নগদ মেসেজ প্যাটার্ন ভ্যালিডেশন
        const isBkashFormat = /You have received (?:Tk|deposit)|Cash In Tk/i.test(sms_body);
        const isNagadFormat = /Money Received|Cash In amount/i.test(sms_body);

        if (!isBkashFormat && !isNagadFormat) {
            console.warn('[REJECTED] SMS does not match official payment confirmation pattern.');
            return res.status(400).json({ success: false, message: 'Invalid payment SMS format.' });
        }

        // ৩. বিকাশ (TrxID) এবং নগদ (TxnID) উভয়ই শনাক্তকরণ
        const trxMatch = sms_body.match(/(?:TrxID|TxnID|TransID|TxId)\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

        // ৪. অ্যামাউন্ট শনাক্তকরণ
        const amountMatch = sms_body.match(/(?:Tk|Amount\s*[:]?\s*Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])).toString() : null;

        // ৫. প্রেরক কাস্টমারের নম্বর শনাক্তকরণ
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

// ২. মাইক্রোটিক হটস্পট লগইন পেজ থেকে TrxID / TxnID ভেরিফিকেশন API
app.post('/api/verify-trx', rateLimiter, async (req, res) => {
    try {
        // নতুন login.html থেকে phone, trxId, এবং mac গ্রহণ
        const phone = req.body.phone || req.body.username;
        const trxId = req.body.trxId;
        const mac = req.body.mac;

        if (!phone || !trxId) {
            return res.status(400).json({ success: false, message: 'মোবাইল নম্বর ও TrxID দিন।' });
        }

        const cleanTrx = trxId.trim().toUpperCase();
        let cleanPhone = phone.trim().replace(/[^0-9]/g, '');
        if (cleanPhone.length >= 11) cleanPhone = cleanPhone.slice(-11);

        // MAC অ্যাড্রেস থাকলে তা ইউজারনেম হিসেবে সেট হবে, অন্যথায় ফোন নম্বর
        let cleanUsername = cleanPhone;
        if (mac && mac !== '$(mac)' && mac.trim().length >= 11) {
            cleanUsername = mac.trim().toUpperCase();
        }

        const cleanPassword = cleanPhone;

        const store = loadTransactions();
        const transaction = store[cleanTrx];

        // ১. ট্রানজেকশন ডাটাবেজে আছে কি না
        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: `ট্রানজেকশন আইডি (${cleanTrx}) পাওয়া যায়নি! বিকাশ বা নগদের সঠিক TrxID দিন।`
            });
        }

        // ২. আগে ব্যবহার হয়েছে কি না
        if (transaction.used) {
            return res.status(400).json({
                success: false,
                message: 'এই TrxID দিয়ে আগেই ইন্টারনেট সক্রিয় করা হয়েছে।'
            });
        }

        const profile = PRICE_PROFILE_MAP[transaction.amount] || 'Profile-1Hour';
        const senderInfo = transaction.phone ? ` | Payer: ${transaction.phone}` : '';
        const method = transaction.gateway || 'Pay';
        const commentText = `${method}: ${cleanTrx} | Phone: ${cleanPhone} | Tk: ${transaction.amount}${senderInfo} | Date: ${new Date().toLocaleDateString('en-GB')}`;

        // ইউজারের অ্যাকাউন্ট নিশ্চিত করা (Username = MAC, Password = Phone)
        await ensureUser(cleanUsername, cleanPassword, commentText);

        // প্রোফাইল যুক্ত বা রিনিউ করা
        await attachProfile(cleanUsername, profile);

        // কমেন্ট আপডেট
        await updateUserComment(cleanUsername, commentText);

        // ট্রানজেকশন লক করা
        transaction.used = true;
        transaction.activatedUser = cleanUsername;
        transaction.phone = cleanPhone;
        transaction.usedAt = Date.now();
        saveTransaction(cleanTrx, transaction);

        console.log(`[SUCCESS] User: ${cleanUsername} (Pass: ${cleanPassword}) recharged via ${method} (${cleanTrx}) - ${transaction.amount} Tk`);

        return res.status(200).json({
            success: true,
            message: `সফল হয়েছে! প্যাকেজ: ${profile}`,
            username: cleanUsername,
            password: cleanPassword,
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
