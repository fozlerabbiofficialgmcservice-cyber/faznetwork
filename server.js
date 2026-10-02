const express = require('express');
const path = require('path');
const https = require('https');
const RosApi = require('node-routeros').RouterOSAPI;

const app = express();
const PORT = process.env.PORT || 3000;

// ১. CORS উন্মুক্ত করা (যাতে হটস্পট পেজ থেকে কোনোভাবেই রিকোয়েস্ট ব্লক না হয়)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// মিডলওয়্যার: JSON, URL-Encoded এবং Plain Text সব গ্রহণ করা
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

// MikroTik রাউটার অ্যাক্সেস (সরাসরি কনফিগারেশন)
const MIKROTIK_HOST = '103.54.37.182';
const MIKROTIK_USER = 'smsbot';
const MIKROTIK_PASSWORD = '66778';
const MIKROTIK_PORT = 1126;

// TrxID স্টোরেজ
const paymentStore = new Map();

// ২. MacroDroid SMS রিসিভার (/forward)
app.post('/forward', (req, res) => {
    let rawText = '';
    
    if (typeof req.body === 'object' && req.body !== null) {
        rawText = req.body.message || JSON.stringify(req.body);
    } else {
        rawText = String(req.body || '');
    }

    console.log(`[SMS Hit] Data: ${rawText}`);

    // বিকাশ ও নগদের TrxID এবং Amount ফিল্টার
    const trxMatch = rawText.match(/(?:TrxID|TxnID|Txn ID|Transaction ID)[:\s]*([A-Z0-9]+)/i);
    const amountMatch = rawText.match(/(?:Tk|BDT|amount)[:\s]*([\d,]+(?:\.\d{2})?)/i);

    if (trxMatch && trxMatch[1]) {
        const trxId = trxMatch[1].trim().toUpperCase();
        const amount = amountMatch ? amountMatch[1].replace(/,/g, '') : '0';

        paymentStore.set(trxId, {
            amount: amount,
            used: false,
            timestamp: Date.now()
        });

        console.log(`[SAVED SUCCESS] TrxID: ${trxId} | Amount: ${amount}`);
        return res.status(200).send('OK');
    }

    // যদি TrxID না-ও পায়, তাহলেও MacroDroid-কে 200 পাঠাবে যাতে হ্যান্ডশেক না কাটে
    return res.status(200).send('Received, but no TrxID');
});

// ৩. সাইন-আপ ও User Manager-এ ইউজার ক্রিয়েট API
app.post('/api/signup', async (req, res) => {
    const { username, password, trxId } = req.body;
    
    if (!username || !password || !trxId) {
        return res.status(400).json({ success: false, message: 'সবগুলো ঘর সঠিকভাবে পূরণ করুন।' });
    }

    const cleanTrx = trxId.trim().toUpperCase();
    const payment = paymentStore.get(cleanTrx);

    if (!payment) {
        return res.status(400).json({ 
            success: false, 
            message: 'ভুল ট্রানজ্যাকশন আইডি অথবা পেমেন্টের এসএমএস এখনও সার্ভারে পৌঁছায়নি।' 
        });
    }

    if (payment.used) {
        return res.status(400).json({ 
            success: false, 
            message: 'এই TrxID পূর্বে ব্যবহার করা হয়েছে।' 
        });
    }

    // MikroTik RouterOS v7 User Manager-এ কানেক্ট
    const conn = new RosApi({
        host: MIKROTIK_HOST,
        user: MIKROTIK_USER,
        password: MIKROTIK_PASSWORD,
        port: MIKROTIK_PORT,
        timeout: 15
    });

    try {
        console.log(`Connecting to MikroTik ${MIKROTIK_HOST}:${MIKROTIK_PORT}...`);
        await conn.connect();
        
        await conn.write('/user-manager/user/add', [
            `=name=${username}`,
            `=password=${password}`
        ]);
        
        await conn.close();

        // সফল হলে TrxID লক করা
        payment.used = true;
        paymentStore.set(cleanTrx, payment);

        console.log(`User created successfully: ${username}`);
        return res.json({ 
            success: true, 
            message: 'পেমেন্ট সফলভাবে ভেরিফাই হয়েছে এবং আপনার অ্যাকাউন্ট সক্রিয় করা হয়েছে!' 
        });
    } catch (error) {
        console.error('MikroTik API Error:', error);
        try { await conn.close(); } catch (e) {}
        return res.status(500).json({ 
            success: false, 
            message: 'রাউটারে অ্যাকাউন্ট তৈরিতে সমস্যা হয়েছে। রাউটার কানেকশন চেক করুন।' 
        });
    }
});

// ৪. index.html সার্ভ করা
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ৫. সেলফ পিং (যাতে Render সার্ভার কখনো ঘুমিয়ে না যায়)
setInterval(() => {
    https.get('https://faznetwork.onrender.com/', (resp) => {
        // সার্ভার সজাগ রাখার পিং
    }).on('error', (err) => {});
}, 10 * 60 * 1000); // প্রতি ১০ মিনিটে একবার পিং করবে

// সার্ভার লিসেন
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
