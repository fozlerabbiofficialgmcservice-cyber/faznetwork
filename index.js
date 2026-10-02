const express = require('express');
const RosApi = require('node-routeros').RouterOSAPI;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// মিডলওয়্যার কনফিগারেশন
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// MikroTik এনভায়রনমেন্ট ভ্যারিয়েবল (Render Environment থেকে মান নেবে)
const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD;
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT, 10) || 8728;

// ট্রানজ্যাকশন ডাটাবেস (মেমোরি স্টোর)
const paymentStore = new Map();

// হোম পেজ রুট (public/index.html লোড করবে)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// হেলথ চেক রুট
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running', service: 'FAZ NETWORK Hotspot API' });
});

// ১. MacroDroid SMS Webhook এন্ডপয়েন্ট
// MacroDroid থেকে JSON বডিতে পাঠাবেন: { "sender": "{sms_number}", "message": "{sms_body}" }
app.post('/api/sms-webhook', (req, res) => {
    const { message, sender } = req.body;

    if (!message) {
        return res.status(400).json({ success: false, message: 'SMS বডি পাওয়া যায়নি।' });
    }

    console.log(`[MacroDroid SMS Received] Sender: ${sender}, Message: ${message}`);

    // রেগুলার এক্সপ্রেশন দিয়ে বিকাশ/নগদের TrxID এবং Amount বের করা
    const trxMatch = message.match(/(?:TrxID|TxnID|Txn ID|Transaction ID)[:\s]*([A-Z0-9]+)/i);
    const amountMatch = message.match(/(?:Tk|BDT|amount)[:\s]*([\d,]+(?:\.\d{2})?)/i);

    if (trxMatch && trxMatch[1]) {
        const trxId = trxMatch[1].trim().toUpperCase();
        const amount = amountMatch ? amountMatch[1].replace(/,/g, '') : '0';

        paymentStore.set(trxId, {
            sender: sender || 'Unknown',
            amount: amount,
            used: false,
            timestamp: Date.now()
        });

        console.log(`[SAVED] TrxID: ${trxId} | Amount: ${amount}`);
        return res.json({ success: true, message: 'SMS parsed successfully', trxId });
    }

    return res.status(422).json({ success: false, message: 'মেসেজে কোনো বৈধ TrxID পাওয়া যায়নি।' });
});

// ২. গ্রাহক সাইন-আপ ও TrxID ভেরিফিকেশন এন্ডপয়েন্ট
app.post('/api/signup', async (req, res) => {
    const { username, password, trxId } = req.body;

    if (!username || !password || !trxId) {
        return res.status(400).json({ success: false, message: 'ইউজারনেম, পাসওয়ার্ড এবং TrxID সবকটি আবশ্যক!' });
    }

    const cleanTrx = trxId.trim().toUpperCase();

    // ১. TrxID মেমোরি স্টোরে আছে কি না পরীক্ষা
    const payment = paymentStore.get(cleanTrx);

    if (!payment) {
        return res.status(400).json({ 
            success: false, 
            message: 'ভুল ট্রানজ্যাকশন আইডি অথবা পেমেন্টের এসএমএস এখনও সার্ভারে পৌঁছায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।' 
        });
    }

    // ২. TrxID আগে ব্যবহার হয়েছে কি না পরীক্ষা
    if (payment.used) {
        return res.status(400).json({ 
            success: false, 
            message: 'এই ট্রানজ্যাকশন আইডিটি ইতোমধ্যে ব্যবহার করা হয়েছে।' 
        });
    }

    // ৩. MikroTik RouterOS v7 User Manager-এ ইউজার ক্রিয়েট
    const conn = new RosApi({
        host: MIKROTIK_HOST,
        user: MIKROTIK_USER,
        password: MIKROTIK_PASSWORD,
        port: MIKROTIK_PORT,
        timeout: 10
    });

    try {
        console.log(`Connecting to MikroTik at ${MIKROTIK_HOST}:${MIKROTIK_PORT}...`);
        await conn.connect();

        // User Manager-এ ইউজার যোগ করার কমান্ড
        await conn.write('/user-manager/user/add', [
            `=name=${username}`,
            `=password=${password}`
        ]);

        await conn.close();

        // TrxID ব্যবহৃত হিসেবে চিহ্নিত করা
        payment.used = true;
        paymentStore.set(cleanTrx, payment);

        console.log(`[USER CREATED] Username: ${username} activated with TrxID: ${cleanTrx}`);
        return res.json({ 
            success: true, 
            message: 'পেমেন্ট সফলভাবে ভেরিফাই হয়েছে এবং আপনার ইন্টারনেট অ্যাকাউন্ট সক্রিয় করা হয়েছে!' 
        });
    } catch (error) {
        console.error('MikroTik Error Details:', error);
        try { await conn.close(); } catch (e) {}
        return res.status(500).json({ 
            success: false, 
            message: 'User Manager-এ অ্যাকাউন্ট তৈরি করা যায়নি বা রাউটারে সংযোগ ব্যর্থ হয়েছে।',
            error: error.message 
        });
    }
});

// সার্ভার চালু করা
app.listen(PORT, () => {
    console.log(`FAZ NETWORK Server is running on port ${PORT}`);
});
