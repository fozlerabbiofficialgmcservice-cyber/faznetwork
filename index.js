const express = require('express');
const RosApi = require('node-routeros').RouterOSAPI;
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const MIKROTIK_CONFIG = {
    host: '103.54.37.182',
    port: 1126,
    user: 'smsbot',
    password: '66778',
    timeout: 10
};

const pendingOrders = new Map();

async function createUserInUserManager(username, password, groupName = 'pppoe') {
    const conn = new RosApi(MIKROTIK_CONFIG);

    try {
        await conn.connect();

        const existingUsers = await conn.write('/user-manager/user/print', [
            `?name=${username}`
        ]);

        if (existingUsers && existingUsers.length > 0) {
            const uId = existingUsers[0]['.id'];
            await conn.write('/user-manager/user/set', [
                `=.id=${uId}`,
                `=disabled=no`,
                `=group=${groupName}`
            ]);
            console.log(`[USER MANAGER] User ${username} updated. Group: ${groupName}`);
        } else {
            await conn.write('/user-manager/user/add', [
                `=name=${username}`,
                `=password=${password || username}`,
                `=group=${groupName}`,
                `=disabled=no`
            ]);
            console.log(`[USER MANAGER] User ${username} created. Group: ${groupName}`);
        }

        try {
            const activeSessions = await conn.write('/user-manager/session/print', [
                `?user=${username}`
            ]);
            for (const sess of activeSessions) {
                await conn.write('/user-manager/session/remove', [`=.id=${sess['.id']}`]);
            }
        } catch (sessErr) {}

        await conn.close();
        return { success: true, message: `User ${username} active in group ${groupName}` };
    } catch (err) {
        if (conn) {
            try { await conn.close(); } catch (e) {}
        }
        console.error('[MIKROTIK ERROR]:', err.message);
        throw err;
    }
}

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

app.post('/api/request-recharge', (req, res) => {
    const { username, group, phone } = req.body;
    if (!username) {
        return res.status(400).json({ success: false, message: 'Username প্রদান করুন।' });
    }

    const cleanUser = username.trim().toLowerCase();
    pendingOrders.set(cleanUser, {
        username: username.trim(),
        group: group || 'pppoe',
        phone: phone || '',
        time: Date.now()
    });

    return res.json({ 
        success: true, 
        message: 'রিচার্জ অর্ডার সাবমিট হয়েছে। SMS আসলে সচল হবে।' 
    });
});

app.post('/forward', async (req, res) => {
    try {
        const { sms_body, sender } = req.body;
        const text = sms_body || '';

        console.log(`[SMS RECEIVED from ${sender || 'Unknown'}]:`, text);

        let detectedUser = null;
        let trxId = null;

        const trxMatch = text.match(/(?:TrxID|TxnID|Trx)\s*[:]?\s*([A-Za-z0-9]+)/i);
        if (trxMatch) trxId = trxMatch[1];

        const refMatch = text.match(/Ref\s*[:]?\s*([A-Za-z0-9_.-]+)/i);
        if (refMatch) {
            detectedUser = refMatch[1].trim();
        }

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

        const orderInfo = pendingOrders.get(detectedUser.toLowerCase());
        const targetGroup = orderInfo ? orderInfo.group : 'pppoe';

        const result = await createUserInUserManager(detectedUser, detectedUser, targetGroup);

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
