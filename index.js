const express = require('express');
const path = require('path');
const RosApi = require('node-routeros').RouterOSAPI;

const app = express();
const PORT = process.env.PORT || 3000;

// মিডলওয়্যার: বডি পার্সিং
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

// MikroTik রাউটার ক্রেডেনশিয়াল
const MIKROTIK_HOST = '103.54.37.182';
const MIKROTIK_USER = 'smsbot';
const MIKROTIK_PASSWORD = '66778';
const MIKROTIK_PORT = 1126;

// TrxID স্টোরেজ
const paymentStore = new Map();

// ১. MacroDroid রুট (POST ও GET উভয় মেথড সাপোর্ট করবে যাতে কোনোভাবেই 404 না আসে)
app.all('/forward', (req, res) => {
    let rawText = '';
    
    if (typeof req.body === 'object' && req.body !== null) {
        rawText = req.body.message || JSON.stringify(req.body);
    } else {
        rawText = String(req.body || '');
    }

    // যদি কুয়েরি প্যারামিটারে ডেটা আসে
    if (!rawText || rawText === '{}') {
        rawText = req.query.message || JSON.stringify(req.query) || '';
    }

    console.log(`[SMS Hit] Data: ${rawText}`);

    // SMS থেকে TrxID এবং টাকার পরিমাণ বের করা
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

    return res.status(200).send('Received, but no TrxID found');
});

// ২. সাইন-আপ ফর্ম API
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
            message: 'ভুল ট্রানজ্যাকশন আইডি অথবা পেমেন্টের এসএমএস এখনও সার্ভারে পৌঁছায়নি।' 
        });
    }

    if (payment.used) {
        return res.status(400).json({ 
            success: false, 
            message: 'এই TrxID পূর্বে ব্যবহার করা হয়েছে।' 
        });
    }

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

        return res.json({ success: true, message: 'অ্যাকাউন্ট সফলভাবে সক্রিয় করা হয়েছে!' });
    } catch (error) {
        console.error('MikroTik Error:', error);
        try { await conn.close(); } catch (e) {}
        return res.status(500).json({ success: false, message: 'রাউটারে ইউজার তৈরিতে সমস্যা হয়েছে।' });
    }
});

// ৩. ফ্রন্টএন্ড পেজ সার্ভ করা
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`FAZ NETWORK Server is running on port ${PORT}`);
});
