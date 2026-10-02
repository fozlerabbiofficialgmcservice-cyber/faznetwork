const express = require('express');
const path = require('path');
const RosApi = require('node-routeros').RouterOSAPI;

const app = express();
const PORT = process.env.PORT || 3000;

// মিডলওয়্যার কনফিগারেশন
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

// MikroTik সরাসরি কনফিগারেশন (কোনো Env Variable লাগবে না)
const MIKROTIK_HOST = '103.54.37.182';
const MIKROTIK_USER = 'smsbot';
const MIKROTIK_PASSWORD = '66778';
const MIKROTIK_PORT = 1126;

// TrxID মেমোরি স্টোর
const paymentStore = new Map();

// ১. MacroDroid SMS রিসিভার (/forward)
app.post('/forward', (req, res) => {
    let rawText = '';
    
    if (typeof req.body === 'object' && req.body !== null) {
        rawText = req.body.message || JSON.stringify(req.body);
    } else {
        rawText = String(req.body || '');
    }

    console.log(`[SMS Hit] Data: ${rawText}`);

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

    return res.status(200).send('No TrxID found');
});

// ২. গ্রাহক সাইন-আপ ও User Manager এ ইউজার তৈরি API
app.post('/api/signup', async (req, res) => {
    const { username, password, trxId } = req.body;
    if (!username || !password || !trxId) {
        return res.status(400).json({ success: false, message: 'সবগুলো ঘর পূরণ করুন।' });
    }

    const cleanTrx = trxId.trim().toUpperCase();
    const payment = paymentStore.get(cleanTrx);

    if (!payment) {
        return res.status(400).json({ 
            success: false, 
            message: 'ভুল ট্রানজ্যাকশন আইডি অথবা পেমেন্টের এসএমএস এখনও আসেনি।' 
        });
    }

    if (payment.used) {
        return res.status(400).json({ 
            success: false, 
            message: 'এই TrxID পূর্বে ব্যবহার করা হয়েছে।' 
        });
    }

    // MikroTik RouterOS v7 User Manager এ কানেক্ট
    const conn = new RosApi({
        host: MIKROTIK_HOST,
        user: MIKROTIK_USER,
        password: MIKROTIK_PASSWORD,
        port: MIKROTIK_PORT,
        timeout: 10
    });

    try {
        await conn.connect();
        await conn.write('/user-manager/user/add', [
            `=name=${username}`,
            `=password=${password}`
        ]);
        await conn.close();

        payment.used = true;
        paymentStore.set(cleanTrx, payment);

        return res.json({ success: true, message: 'অ্যাকাউন্ট সফলভাবে সক্রিয় করা হয়েছে!' });
    } catch (error) {
        console.error('MikroTik Error:', error);
        try { await conn.close(); } catch (e) {}
        return res.status(500).json({ success: false, message: 'রাউটারে অ্যাকাউন্ট তৈরিতে সমস্যা হয়েছে।' });
    }
});

// ৩. সরাসরি আপনার সুন্দর index.html পেজটি ওপেন হওয়া
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// সার্ভার চালু
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
