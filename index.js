const express = require('express');
const net = require('net');
const path = require('path');

// কোনো অপ্রত্যাশিত এররেও যাতে সার্ভার বন্ধ না হয়
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

const pendingOrders = new Map();

// RouterOS API দৈর্ঘ্য এনকোডিং হেল্পার
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

// সরাসরি সকেট দিয়ে কমান্ড এক্সিকিউট করা (RouterOS v7 Safe)
function sendMikrotikCommands(commands) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let currentCommandIndex = 0;
        let isDone = false;

        const timeoutId = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                client.destroy();
                resolve({ success: true, warning: 'Command executed with timeout' });
            }
        }, 8000);

        client.connect(MIKROTIK_PORT, MIKROTIK_HOST, () => {
            // ১. লগইন শুরু (RouterOS v6/v7 post-login)
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

            // লগইন সফল হয়েছে
            if (responseStr.includes('!done') && currentCommandIndex === 0) {
                buffer = Buffer.alloc(0);
                executeNext();
            } else if (responseStr.includes('!done') || responseStr.includes('!empty') || responseStr.includes('!trap')) {
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
            // ১. ইউজার না থাকলে তৈরি করবে
            ['/user-manager/user/add', `=name=${username}`, `=password=${username}`, `=disabled=no`],
            // ২. ইউজার এনাবল নিশ্চিত করা
            ['/user-manager/user/enable', `?name=${username}`],
            // ৩. প্যাকেজ/প্রোফাইল অ্যাসাইন করা
            ['/user-manager/user-profile/add', `=user=${username}`, `=profile=${profileName}`]
        ];

        console.log(`[MIKROTIK] Activating ${username} with ${profileName}...`);
        await sendMikrotikCommands(commands);
        return { success: true, message: `User ${username} configured with ${profileName}` };
    } catch (err) {
        console.error('[ACTIVATION ERROR]:', err.message);
        return { success: false, error: err.message };
    }
}

app.get('/', (req, res) => {
    return res.status(200).send('FAZ NETWORK User Manager Server is Running!');
});

app.post('/api/request-recharge', (req, res) => {
    const { username, profile, phone } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username প্রদান করুন।' });
    const cleanUser = username.trim().toLowerCase();
    pendingOrders.set(cleanUser, {
        username: username.trim(),
        profile: profile || 'Profile - 30Day',
        phone: phone || '',
        time: Date.now()
    });
    return res.json({ success: true, message: 'রিচার্জের অনুরোধ জমা হয়েছে।' });
});

app.post('/forward', async (req, res) => {
    try {
        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = req.query.sender || req.body.sender || req.body.from || '';

        if (typeof req.body === 'string') {
            sms_body = req.body;
        }

        console.log(`[SMS RECEIVED from ${sender}]: ${sms_body}`);

        let detectedUser = null;
        let amount = null;

        // টাকা বের করা
        const amountMatch = sms_body.match(/(?:Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (amountMatch) {
            amount = Math.floor(parseFloat(amountMatch[1])).toString();
        }

        // রেফারেন্স বের করা
        const refMatch = sms_body.match(/Ref\s*[:]?\s*([A-Za-z0-9_.-]+)/i);
        if (refMatch && refMatch[1].trim() !== '0') {
            detectedUser = refMatch[1].trim();
        }

        // বিকাশ এসএমএস থেকে নম্বর বের করা (from 01710415717)
        if (!detectedUser) {
            const phoneInMsg = sms_body.match(/(?:from|sender)\s*[:]?\s*(?:\+?88)?(01[3-9][0-9]{8})/i);
            if (phoneInMsg && phoneInMsg[1]) {
                detectedUser = phoneInMsg[1];
            }
        }

        // সেন্ডার নম্বর
        if (!detectedUser && sender) {
            let cleanPhone = sender.replace(/[^0-9]/g, '');
            if (cleanPhone.startsWith('880')) {
                cleanPhone = cleanPhone.substring(2);
            } else if (cleanPhone.startsWith('88')) {
                cleanPhone = cleanPhone.substring(2);
            }
            if (cleanPhone.length >= 10) {
                detectedUser = cleanPhone;
            }
        }

        if (!detectedUser && pendingOrders.size > 0) {
            const lastEntry = Array.from(pendingOrders.values()).pop();
            detectedUser = lastEntry.username;
        }

        if (!detectedUser) {
            return res.status(200).json({ 
                success: true, 
                message: 'মেসেজ গৃহীত হয়েছে, কোনো কাস্টমার নম্বর পাওয়া যায়নি।' 
            });
        }

        // প্যাকেজ নির্ধারণ
        let selectedProfile = 'Profile - 1Hour';
        if (amount && PRICE_PROFILE_MAP[amount]) {
            selectedProfile = PRICE_PROFILE_MAP[amount];
        } else if (pendingOrders.has(detectedUser.toLowerCase())) {
            selectedProfile = pendingOrders.get(detectedUser.toLowerCase()).profile;
        }

        console.log(`[PROCESS] Activating User: ${detectedUser} | Profile: ${selectedProfile} | Amount: ${amount}`);

        // মিক্রোটিক অ্যাক্টিভেশন কল
        const result = await activateUserOnMikrotik(detectedUser, selectedProfile);
        pendingOrders.delete(detectedUser.toLowerCase());

        return res.status(200).json({
            success: true,
            user: detectedUser,
            amount: amount,
            profile: selectedProfile,
            mikrotik: result
        });
    } catch (error) {
        console.error('[FORWARD ERROR]:', error.message);
        return res.status(200).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
