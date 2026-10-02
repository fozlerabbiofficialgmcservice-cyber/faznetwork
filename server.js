const express = require('express');
const RosApi = require('node-routeros').RouterOSAPI;
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// স্ট্যাটিক পোর্টাল ও ফাইল সার্ভিস
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ==========================================
// আপনার MikroTik RB4011 কনফিগারেশন
// ==========================================
const MIKROTIK_CONFIG = {
    host: '103.54.37.182', // আপনার রিয়েল আইপি / হোস্ট
    port: 1126,             // আপনার API ফরওয়ার্ডেড পোর্ট
    user: 'smsbot',         // API ইউজারনেম
    password: '66778',      // পাসওয়ার্ড
    timeout: 10
};

// মেমোরিতে পেন্ডিং রিচার্জ ট্র্যাকিং
const pendingOrders = new Map();

// ==========================================
// MikroTik RouterOS v7 User Manager ফাংশন
// ==========================================
async function createUserInUserManager(username, password, groupName = 'pppoe') {
    const conn = new RosApi(MIKROTIK_CONFIG);

    try {
        await conn.connect();

        // ১. চেক করা ইউজার আগে থেকেই User Manager-এ আছে কি না
        const existingUsers = await conn.write('/user-manager/user/print', [
            `?name=${username}`
        ]);

        if (existingUsers && existingUsers.length > 0) {
            const uId = existingUsers[0]['.id'];
            // ইউজার থাকলে তাকে এনাবল এবং গ্রুপ/প্রোফাইল আপডেট করা
            await conn.write('/user-manager/user/set', [
                `=.id=${uId}`,
                `=disabled=no`,
                `=group=${groupName}`
            ]);
            console.log(`[USER MANAGER] User ${username} already existed. Re-enabled in group ${groupName}`);
        } else {
            // নতুন ইউজার তৈরি করা (RouterOS v7)
            await conn.write('/user-manager/user/add', [
                `=name=${username}`,
                `=password=${password || username}`,
                `=group=${groupName}`,
                `=disabled=no`
            ]);
            console.log(`[USER MANAGER] User ${username} newly created in group: ${groupName}`);
        }

        // ২. ইউজার যদি একটিভ সেশনে আটকে থাকে, তবে রিমুভ করা যাতে নতুনভাবে কানেক্ট হতে পারে
        try {
            const activeSessions = await conn.write('/user-manager/session/print', [
                `?user=${username}`
            ]);
            for (const sess of activeSessions) {
                await conn.write('/user-manager/session/remove', [`=.id=${sess['.id']}`]);
            }
        } catch (sessErr) {
            // সেশন না থাকলে ইগনোর করবে
        }

        await conn.close();
        return { success: true, message: `User ${username} successfully active in group ${groupName}` };
    } catch (err) {
        if (conn) {
            try { await conn.close(); } catch (e) {}
        }
        console.error('[MIKROTIK ERROR]:', err.message);
        throw err;
    }
}

// ==========================================
// পোর্টাল রুট (index.html লোড)
// ==========================================
app.get('/', (req, res) => {
    const rootPath = path.join(__dirname, 'index.html');
    const publicPath = path.join(__dirname, 'public', 'index.html');

    if (fs.existsSync(publicPath)) {
        return res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        return res.sendFile(rootPath);
    } else {
        return res.status(404).send('index.html ফাইলটি পাওয়া যায়নি!');
    }
});

// পোর্টাল থেকে রিচার্জ রিকোয়েস্ট জমা দেওয়ার API
app.post('/api/request-recharge', (req, res) => {
    const { username, group, phone } = req.body;
    if (!username) {
        return res.status(400).json({ success: false, message: 'Username প্রদান করুন।' });
    }

    const cleanUser = username.trim().toLowerCase();
    pendingOrders.set(cleanUser, {
        username: username.trim(),
        group: group || 'pppoe', // pppoe অথবা hotspot গ্রুপ
        phone: phone || '',
        time: Date.now()
    });

    return res.json({ 
        success: true, 
        message: 'রিচার্জ অর্ডার সাবমিট হয়েছে। বিকাশে টাকা পাঠানোর পর SMS আসলে স্বয়ংক্রিয়ভাবে সচল হবে।' 
    });
});

// ==========================================
// MacroDroid SMS Webhook
// ==========================================
app.post('/api/macrodroid-sms', async (req, res) => {
    try {
        const { sms_body, sender } = req.body;
        const text = sms_body || '';

        console.log(`[SMS RECEIVED from ${sender || 'Unknown'}]:`, text);

        let detectedUser = null;
        let trxId = null;

        // TrxID বের করার রেজেক্স
        const trxMatch = text.match(/(?:TrxID|TxnID|Trx)\s*[:]?\s*([A-Za-z0-9]+)/i);
        if (trxMatch) trxId = trxMatch[1];

        // Ref থেকে ইউজারনেম বের করা (যেমন: Ref: user101 অথবা Ref user101)
        const refMatch = text.match(/Ref\s*[:]?\s*([A-Za-z0-9_.-]+)/i);
        if (refMatch) {
            detectedUser = refMatch[1].trim();
        }

        // যদি মেসেজে Ref না থাকে কিন্তু পোর্টালে সাম্প্রতিক পেন্ডিং রিকোয়েস্ট থাকে
        if (!detectedUser && pendingOrders.size > 0) {
            const lastEntry = Array.from(pendingOrders.values()).pop();
            detectedUser = lastEntry.username;
        }

        if (!detectedUser) {
            return res.status(400).json({ 
                success: false, 
                error: 'মেসেজ থেকে গ্রাহকের আইডি (Ref) পাওয়া যায়নি।' 
            });
        }

        // গ্রুপ নির্বাচন (পোর্টালে ইউজার হটস্পট দিলে হটস্পট, নয়তো ডিফল্ট pppoe)
        const orderInfo = pendingOrders.get(detectedUser.toLowerCase());
        const targetGroup = orderInfo ? orderInfo.group : 'pppoe';

        // MikroTik RB4011 RouterOS v7 User Manager-এ ইউজার ক্রিয়েট/রিনিউ
        const result = await createUserInUserManager(detectedUser, detectedUser, targetGroup);

        // কাজ শেষ হলে পেন্ডিং তালিকা থেকে মুছে ফেলা
        pendingOrders.delete(detectedUser.toLowerCase());

        return res.status(200).json({
            success: true,
            user: detectedUser,
            trxId: trxId,
            group: targetGroup,
            mikrotik: result
        });

    } catch (error) {
        console.error('[WEBHOOK ERROR]:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
