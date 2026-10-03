const express = require('express');
const RosApi = require('node-routeros').RouterOSAPI;
const path = require('path');
const fs = require('fs');

// আনহ্যান্ডল্ড এররে সার্ভার ক্র্যাশ বন্ধ করার জন্য গ্লোবাল গার্ড
process.on('uncaughtException', (err) => {
    if (err && (err.message?.includes('!empty') || err.errno === 'UNKNOWNREPLY')) {
        console.log('[MIKROTIK SAFE NOTICE] Handled unknown reply (!empty) safely.');
        return;
    }
    console.error('[UNCAUGHT EXCEPTION]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('[UNHANDLED REJECTION]:', reason);
});

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const MIKROTIK_CONFIG = {
    host: process.env.MIKROTIK_HOST || '103.54.37.182',
    port: parseInt(process.env.MIKROTIK_PORT) || 1126,
    user: process.env.MIKROTIK_USER || 'smsbot',
    password: process.env.MIKROTIK_PASSWORD || '66778',
    timeout: 10
};

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

async function assignUserProfile(username, profileName) {
    const conn = new RosApi(MIKROTIK_CONFIG);

    // লাইব্রেরির কানেকশন এরর ইভেন্ট হ্যান্ডলিং
    if (conn.on) {
        conn.on('error', (err) => {
            console.log('[ROUTEROS EVENT ERROR]:', err?.message || err);
        });
    }

    try {
        await conn.connect();

        // ১. ইউজার আগে থেকে আছে কি না দেখা
        let existingUsers = [];
        try {
            existingUsers = await conn.write('/user-manager/user/print', [`?name=${username}`]);
        } catch (e) {
            existingUsers = [];
        }

        // ২. না থাকলে অ্যাড করা, থাকলে এনেবল করা
        if (!existingUsers || existingUsers.length === 0) {
            try {
                await conn.write('/user-manager/user/add', [
                    `=name=${username}`,
                    `=password=${username}`,
                    `=disabled=no`
                ]);
                console.log(`[USER MANAGER] User ${username} created.`);
            } catch (e) {
                console.log(`[USER MANAGER] User add notice:`, e.message);
            }
        } else {
            try {
                const uId = existingUsers[0]['.id'];
                await conn.write('/user-manager/user/set', [
                    `=.id=${uId}`,
                    `=disabled=no`
                ]);
                console.log(`[USER MANAGER] User ${username} enabled.`);
            } catch (e) {
                console.log(`[USER MANAGER] User enable notice:`, e.message);
            }
        }

        // ৩. ইউজারের সাথে প্রোফাইল যুক্ত করা
        try {
            await conn.write('/user-manager/user-profile/add', [
                `=user=${username}`,
                `=profile=${profileName}`
            ]);
            console.log(`[USER MANAGER] Profile '${profileName}' assigned to ${username}`);
        } catch (e) {
            console.log(`[USER MANAGER] User-profile add notice:`, e.message);
        }

        // ৪. পুরনো সেশন রিমুভ করা
        try {
            const activeSessions = await conn.write('/user-manager/session/print', [`?user=${username}`]);
            if (Array.isArray(activeSessions)) {
                for (const sess of activeSessions) {
                    if (sess && sess['.id']) {
                        await conn.write('/user-manager/session/remove', [`=.id=${sess['.id']}`]);
                    }
                }
            }
        } catch (sessErr) {
            console.log('[USER MANAGER] Session clean notice:', sessErr.message);
        }

        try { await conn.close(); } catch (e) {}
        return { success: true, message: `User ${username} activated with profile ${profileName}` };
    } catch (err) {
        if (conn) {
            try { await conn.close(); } catch (e) {}
        }
        console.error('[MIKROTIK PROCESS ERROR]:', err.message);
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
        console.log('[DEBUG] Received Body:', req.body);
        console.log('[DEBUG] Received Query:', req.query);

        let sms_body = req.query.sms_body || req.body.sms_body || req.query['sms body'] || req.body['sms body'] || req.body.sms_message || req.body.message || '';
        let sender = req.query.sender || req.body.sender || req.body.from || '';

        if (typeof req.body === 'string') {
            sms_body = req.body;
        }

        console.log(`[SMS RECEIVED from ${sender}]: ${sms_body}`);

        let detectedUser = null;
        let amount = null;

        // টাকা নির্ধারণ
        const amountMatch = sms_body.match(/(?:Tk|Amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (amountMatch) {
            amount = Math.floor(parseFloat(amountMatch[1])).toString();
        }

        // রেফারেন্স চেক
        const refMatch = sms_body.match(/Ref\s*[:]?\s*([A-Za-z0-9_.-]+)/i);
        if (refMatch && refMatch[1].trim() !== '0') {
            detectedUser = refMatch[1].trim();
        }

        // মেসেজের ভেতরের মোবাইল নম্বর রিড করা (যেমন: from 01710415717)
        if (!detectedUser) {
            const phoneInMsg = sms_body.match(/(?:from|sender)\s*[:]?\s*(?:\+?88)?(01[3-9][0-9]{8})/i);
            if (phoneInMsg && phoneInMsg[1]) {
                detectedUser = phoneInMsg[1];
            }
        }

        // সেন্ডার নম্বর থেকে নেওয়া
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

        // ওয়েব ফর্মের পেন্ডিং রিকোয়েস্ট থেকে নেওয়া
        if (!detectedUser && pendingOrders.size > 0) {
            const lastEntry = Array.from(pendingOrders.values()).pop();
            detectedUser = lastEntry.username;
        }

        if (!detectedUser) {
            console.log('[INFO] কোনো ইউজারনেম বা মোবাইল নম্বর পাওয়া যায়নি।');
            return res.status(200).json({ 
                success: true, 
                message: 'মেসেজ সার্ভারে এসেছে, তবে কোনো গ্রাহক নম্বর পাওয়া যায়নি।' 
            });
        }

        // প্যাকেজ নির্ধারণ
        let selectedProfile = 'Profile - 1Hour';
        if (amount && PRICE_PROFILE_MAP[amount]) {
            selectedProfile = PRICE_PROFILE_MAP[amount];
        } else if (pendingOrders.has(detectedUser.toLowerCase())) {
            selectedProfile = pendingOrders.get(detectedUser.toLowerCase()).profile;
        }

        console.log(`[PROCESS] Activating User: ${detectedUser} with Profile: ${selectedProfile} (Amount: ${amount})`);

        const result = await assignUserProfile(detectedUser, selectedProfile);
        pendingOrders.delete(detectedUser.toLowerCase());

        return res.status(200).json({
            success: true,
            user: detectedUser,
            amount: amount,
            profile: selectedProfile,
            mikrotik: result
        });
    } catch (error) {
        console.error('[WEBHOOK ERROR]:', error.message);
        return res.status(200).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
