const express = require('express');
const { RouterOSAPI } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 10000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.text({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pendingPayments = new Map();

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]:', reason);
});

app.get('/', (req, res) => {
    res.send('FAZ Network User Manager Server is Running!');
});

async function createUserManagerUser(username, password, profileName, commentText) {
    const api = new RouterOSAPI({
        host: '103.54.37.182',
        port: 1126,
        user: 'smsbot',
        password: '66778',
        timeout: 10
    });

    try {
        await api.connect();

        try {
            await api.write('/user-manager/user/add', [
                `=name=${username}`,
                `=password=${password}`,
                `=comment=${commentText}`,
                '=group=Hotspot',
                '=disabled=no'
            ]);
            console.log(`[USER CREATED]: ${username}`);
        } catch (addErr) {
            console.log(`[USER ALREADY EXISTS, UPDATING]: ${username}`);
            await api.write('/user-manager/user/set', [
                `=numbers=${username}`,
                `=password=${password}`,
                `=comment=${commentText}`
            ]);
        }

        await api.write('/user-manager/user-profile/add', [
            `=user=${username}`,
            `=profile=${profileName}`
        ]);

        console.log(`[SUCCESS] Profile '${profileName}' assigned to: ${username}`);
        return true;
    } catch (err) {
        console.error('[ROUTER ACTION ERROR]:', err.message || err);
        return false;
    } finally {
        try {
            await api.close();
        } catch (_) {}
    }
}

function getProfileByAmount(amount) {
    if (amount === 10) return 'Profile-1Hour';
    if (amount === 15) return 'Profile-12Hour';
    if (amount === 20) return 'Profile-1Day';
    if (amount === 40) return 'Profile-3Day';
    if (amount === 60) return 'Profile-7Day';
    if (amount === 90) return 'Profile-15Day';
    if (amount === 150) return 'Profile-30Day';
    if (amount === 200) return 'Profile-100GB';
    if (amount === 350) return 'Profile-300GB';
    return null;
}

app.all('/forward', async (req, res) => {
    let rawMessage = '';
    
    if (req.query && req.query.message) {
        rawMessage = String(req.query.message);
    } else if (typeof req.body === 'string' && req.body.trim().length > 0) {
        rawMessage = req.body;
    } else if (req.body && req.body.message) {
        rawMessage = String(req.body.message);
    } else if (req.body && Object.keys(req.body).length > 0) {
        rawMessage = JSON.stringify(req.body);
    }

    const sender = (req.query?.sender || req.body?.sender || '').toString();

    console.log('--- Incoming Request ---');
    console.log('Raw Message:', rawMessage);
    console.log('Sender:', sender);

    const amountMatch = rawMessage.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? Math.round(parseFloat(amountMatch[1].replace(',', ''))) : 0;

    const phoneMatch = rawMessage.match(/(01[3-9]\d{8})/);
    let customerNumber = null;
    if (phoneMatch) {
        customerNumber = phoneMatch[1];
    } else if (sender) {
        const cleanSender = sender.replace(/[^0-9]/g, '');
        if (cleanSender.length >= 11) {
            customerNumber = cleanSender.slice(-11);
        }
    }

    const trxMatch = rawMessage.match(/TrxID[:\s]+([A-Z0-9]+)/i);
    const trxId = trxMatch ? trxMatch[1] : null;
    const profile = getProfileByAmount(amount);

    if (trxId) {
        pendingPayments.set(trxId.toUpperCase(), {
            phone: customerNumber,
            amount: amount,
            profile: profile,
            time: Date.now()
        });
    }

    if (customerNumber && profile) {
        const comment = `Auto SMS Trx: ${trxId || 'N/A'}, Tk: ${amount}`;
        await createUserManagerUser(customerNumber, customerNumber, profile, comment);
        return res.status(200).send(`OK: Processed for ${customerNumber}`);
    }

    return res.status(200).send('Logged for manual or signup verification');
});

app.post('/api/signup', async (req, res) => {
    const { username, password, trxId, phone } = req.body;
    const targetUser = username || phone;

    if (!targetUser || !password) {
        return res.status(400).json({ success: false, message: 'ইউজারনেম ও পাসওয়ার্ড দেওয়া বাধ্যতামূলক।' });
    }

    if (trxId) {
        const cleanTrx = trxId.trim().toUpperCase();
        const payment = pendingPayments.get(cleanTrx);

        if (!payment) {
            return res.status(400).json({ 
                success: false, 
                message: 'ট্রানজেকশন আইডি পাওয়া যায়নি বা পেমেন্ট এখনো রিসিভ হয়নি।' 
            });
        }

        const comment = `Web Signup Trx: ${cleanTrx}, Tk: ${payment.amount}`;
        const created = await createUserManagerUser(targetUser, password, payment.profile, comment);

        if (created) {
            pendingPayments.delete(cleanTrx);
            return res.json({ success: true, message: 'অ্যাকাউন্ট সফলভাবে তৈরি হয়েছে!' });
        } else {
            return res.status(500).json({ success: false, message: 'রাউটারে অ্যাকাউন্ট তৈরি করতে ব্যর্থ হয়েছে।' });
        }
    }

    const defaultProfile = 'Profile-1Hour';
    const comment = `Web Free/Direct Signup`;
    const created = await createUserManagerUser(targetUser, password, defaultProfile, comment);

    if (created) {
        return res.json({ success: true, message: 'অ্যাকাউন্ট তৈরি হয়েছে!' });
    } else {
        return res.status(500).json({ success: false, message: 'অ্যাকাউন্টে তৈরিতে সমস্যা হয়েছে।' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
