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

function sendMikrotikCommands(commands) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let currentCommandIndex = 0;
        let isDone = false;

        const timeoutId = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                client.destroy();
                resolve({ success: true, warning: 'Timeout handled' });
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

        client.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            const responseStr = buffer.toString('utf-8');
            if (responseStr.includes('!done') || responseStr.includes('!empty') || responseStr.includes('!trap')) {
                buffer = Buffer.alloc(0);
                executeNext();
            }
        });

        function executeNext() {
            if (currentCommandIndex < commands.length) {
                const cmd = commands[currentCommandIndex++];
                console.log(`[MIKROTIK EXEC]: ${cmd[0]}`);
                const words = cmd.map(w => encodeWord(w));
                words.push(Buffer.from([0x00]));
                client.write(Buffer.concat(words));
            } else {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(timeoutId);
                    client.end();
                    resolve({ success: true });
                }
            }
        }

        client.on('error', (err) => {
            console.error('[SOCKET ERROR]:', err.message);
            if (!isDone) {
                isDone = true;
                clearTimeout(timeoutId);
                client.destroy();
                resolve({ success: false, error: err.message });
            }
        });

        client.on('close', () => {
            if (!isDone) {
                isDone = true;
                clearTimeout(timeoutId);
                resolve({ success: true });
            }
        });
    });
}

async function activateUserOnMikrotik(username, profileName) {
    try {
        const commands = [
            ['/user-manager/user/add', `=name=${username}`, `=password=${username}`, `=disabled=no`],
            ['/user-manager/user/enable', `?name=${username}`],
            ['/user-manager/user-profile/add', `=user=${username}`, `=profile=${profileName}`]
        ];

        console.log(`[MIKROTIK] Activating ${username} with ${profileName}...`);
        await sendMikrotikCommands(commands);
        return { success: true, message: `User ${username} configured with ${profileName}` };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

app.get('/', (req, res) => {
    return res.status(200).send('FAZ NETWORK User Manager Server is Running!');
});

// ১. SMS Webhook Endpoint
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

        if (trxId && amount) {
            saveTransaction(trxId, {
                amount: amount,
                sender: sender,
                used: false,
                receivedAt: Date.now()
            });
            console.log(`[SUCCESSFULLY SAVED TO DISK] TrxID: ${trxId} | Amount: ${amount}`);
        }

        return res.status(200).json({ success: true, trxId, amount });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ২. TrxID ভেরিফিকেশন Endpoint
app.post('/api/verify-trx', async (req, res) => {
    try {
        const { username, trxId } = req.body;

        if (!username || !trxId) {
            return res.status(400).json({ success: false, message: 'ইউজারনেম এবং TrxID সঠিকভাবে প্রদান করুন।' });
        }

        const cleanTrx = trxId.trim().toUpperCase();
        const cleanUser = username.trim();

        const store = loadTransactions();
        const transaction = store[cleanTrx];

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: `TrxID (${cleanTrx}) সার্ভারে পাওয়া যায়নি! আপনার ম্যাক্রোড্রয়েড থেকে মেসেজটি ফরোয়ার্ড হয়েছে কিনা নিশ্চিত করুন।`
            });
        }

        if (transaction.used) {
            return res.status(400).json({
                success: false,
                message: 'এই TrxID দিয়ে আগেই রিচার্জ সম্পন্ন করা হয়েছে।'
            });
        }

        const profile = PRICE_PROFILE_MAP[transaction.amount] || 'Profile - 1Hour';
        const result = await activateUserOnMikrotik(cleanUser, profile);

        transaction.used = true;
        saveTransaction(cleanTrx, transaction);

        return res.status(200).json({
            success: true,
            message: `আলহামদুলিল্লাহ! আপনার ${profile} সফলভাবে চালু হয়েছে।`,
            user: cleanUser,
            profile: profile,
            amount: transaction.amount,
            mikrotik: result
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
