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
        const data = fs.readFileSync(DB_FILE, 'utf-8');
        return JSON.parse(data || '{}');
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

// MikroTik Socket Executor
function runMikrotikApi(commands) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let commandQueue = [...commands];
        let isDone = false;

        const timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                client.destroy();
                resolve({ success: true, note: 'Timeout completed' });
            }
        }, 10000);

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
            const res = buffer.toString('utf-8');

            if (res.includes('!done') || res.includes('!empty') || res.includes('!trap')) {
                buffer = Buffer.alloc(0);
                if (commandQueue.length > 0) {
                    const nextCmd = commandQueue.shift();
                    console.log(`[MIKROTIK EXEC]: ${nextCmd.join(' ')}`);
                    const payload = nextCmd.map(w => encodeWord(w));
                    payload.push(Buffer.from([0x00]));
                    client.write(Buffer.concat(payload));
                } else {
                    if (!isDone) {
                        isDone = true;
                        clearTimeout(timer);
                        client.end();
                        resolve({ success: true });
                    }
                }
            }
        });

        client.on('error', (err) => {
            console.error('[SOCKET ERROR]:', err.message);
            if (!isDone) {
                isDone = true;
                clearTimeout(timer);
                client.destroy();
                resolve({ success: false, error: err.message });
            }
        });

        client.on('close', () => {
            if (!isDone) {
                isDone = true;
                clearTimeout(timer);
                resolve({ success: true });
            }
        });
    });
}

// ধাপ ১: শুধু ইউজার তৈরি করা (প্রোফাইল ছাড়া)
async function createUserOnly(username) {
    console.log(`[USER MANAGER] Step 1: Pre-creating User ${username}`);
    const cmds = [
        ['/user-manager/user/add', `=name=${username}`, `=password=${username}`, `=disabled=no`]
    ];
    return await runMikrotikApi(cmds);
}

// ধাপ ২: TrxID দিয়ে ভেরিফাই হওয়ার পর Profile ও Comment সেট করা
async function activateProfileAndComment(username, profileName, commentText) {
    console.log(`[USER MANAGER] Step 2: Setting Profile & Comment for ${username}`);
    const cmds = [
        // নিশ্চিত ইউজার তৈরি আছে কি না
        ['/user-manager/user/add', `=name=${username}`, `=password=${username}`, `=disabled=no`],
        // ইউজারের কমেন্ট আপডেট করা (TrxID সহ)
        ['/user-manager/user/set', `=numbers=${username}`, `=comment=${commentText}`],
        // প্রোফাইল যুক্ত করা
        ['/user-manager/user-profile/add', `=user=${username}`, `=profile=${profileName}`]
    ];
    return await runMikrotikApi(cmds);
}

app.get('/', (req, res) => {
    return res.status(200).send('FAZ NETWORK Hotspot Server is Running!');
});

// ১. SMS আসার এন্ডপয়েন্ট (ইউজার তৈরি হবে, TrxID ফাইলে সেভ থাকবে)
app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = req.query.sender || req.body.sender || req.body.from || '';

        if (typeof req.body === 'string') sms_body = req.body;
        console.log(`[SMS RECEIVED]: ${sms_body}`);

        // TrxID বের করা
        const trxMatch = sms_body.match(/TrxID\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

        // টাকা বের করা
        const amountMatch = sms_body.match(/(?:Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])).toString() : null;

        // নম্বর বের করা
        let detectedPhone = null;
        const phoneMatch = sms_body.match(/(?:from|sender)\s*[:]?\s*(?:\+?88)?(01[3-9][0-9]{8})/i);
        if (phoneMatch && phoneMatch[1]) {
            detectedPhone = phoneMatch[1];
        } else if (sender) {
            let clean = sender.replace(/[^0-9]/g, '');
            if (clean.length >= 11) detectedPhone = clean.slice(-11);
        }

        // SMS আসলেই আগে ইউজার তৈরি করে রাখা হবে
        if (detectedPhone) {
            await createUserOnly(detectedPhone);
        }

        // TrxID ডিস্কে সেভ রাখা
        if (trxId && amount) {
            saveTransaction(trxId, {
                amount: amount,
                phone: detectedPhone || '',
                used: false,
                receivedAt: Date.now()
            });
            console.log(`[TRX SAVED] TrxID: ${trxId} | Amount: ${amount} | User: ${detectedPhone}`);
        }

        return res.status(200).json({ success: true, trxId, amount, user: detectedPhone });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ২. গ্রাহক যখন ওয়েবসাইটে TrxID সাবমিট করবে
app.post('/api/verify-trx', async (req, res) => {
    try {
        const { username, trxId } = req.body;

        if (!username || !trxId) {
            return res.status(400).json({ success: false, message: 'মোবাইল নম্বর ও TrxID প্রদান করুন।' });
        }

        const cleanTrx = trxId.trim().toUpperCase();
        const cleanUser = username.trim();

        const store = loadTransactions();
        const transaction = store[cleanTrx];

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: `TrxID (${cleanTrx}) পাওয়া যায়নি। অনুগ্রহ করে সঠিক TrxID লিখুন অথবা ১ মিনিট অপেক্ষা করে আবার চেষ্টা করুন।`
            });
        }

        if (transaction.used) {
            return res.status(400).json({
                success: false,
                message: 'এই TrxID দিয়ে আগেই রিচার্জ সম্পন্ন করা হয়েছে।'
            });
        }

        // প্যাকেজ নির্ধারণ
        const profile = PRICE_PROFILE_MAP[transaction.amount] || 'Profile - 1Hour';
        const commentText = `TrxID: ${cleanTrx} | Tk: ${transaction.amount}`;

        // প্রোফাইল ও কমেন্ট সেট করা
        await activateProfileAndComment(cleanUser, profile, commentText);

        // TrxID ব্যবহৃত হিসেবে মার্ক করা
        transaction.used = true;
        transaction.activatedUser = cleanUser;
        saveTransaction(cleanTrx, transaction);

        return res.status(200).json({
            success: true,
            message: `আলহামদুলিল্লাহ! আপনার ${profile} সফলভাবে চালু হয়েছে।`,
            profile: profile,
            user: cleanUser
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
