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

const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD;
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT, 10) || 8728;

const paymentStore = new Map();

// হোম পেজ লোডার (public/index.html অথবা রুট index.html খুঁজে নেবে)
app.get('/', (req, res) => {
    const publicPath = path.resolve(__dirname, 'public', 'index.html');
    const rootPath = path.resolve(__dirname, 'index.html');

    if (fs.existsSync(publicPath)) {
        return res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        return res.sendFile(rootPath);
    } else {
        return res.status(404).send('<h1>index.html file not found in repository!</h1>');
    }
});

// হেলথ চেক
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running', service: 'FAZ NETWORK Hotspot API' });
});

// MacroDroid Webhook
app.post('/api/sms-webhook', (req, res) => {
    const { message, sender } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'SMS empty' });

    const trxMatch = message.match(/(?:TrxID|TxnID|Txn ID|Transaction ID)[:\s]*([A-Z0-9]+)/i);
    const amountMatch = message.match(/(?:Tk|BDT|amount)[:\s]*([\d,]+(?:\.\d{2})?)/i);

    if (trxMatch && trxMatch[1]) {
        const trxId = trxMatch[1].trim().toUpperCase();
        const amount = amountMatch ? amountMatch[1].replace(/,/g, '') : '0';
        paymentStore.set(trxId, { sender: sender || 'Unknown', amount, used: false, timestamp: Date.now() });
        return res.json({ success: true, trxId });
    }
    return res.status(422).json({ success: false });
});

// সাইন-আপ API
app.post('/api/signup', async (req, res) => {
    const { username, password, trxId } = req.body;
    if (!username || !password || !trxId) {
        return res.status(400).json({ success: false, message: 'সবকটি তথ্য দিন।' });
    }

    const cleanTrx = trxId.trim().toUpperCase();
    const payment = paymentStore.get(cleanTrx);

    if (!payment) {
        return res.status(400).json({ success: false, message: 'ভুল TrxID বা পেমেন্ট এসএমএস এখনও আসেনি।' });
    }
    if (payment.used) {
        return res.status(400).json({ success: false, message: 'এই TrxID পূর্বে ব্যবহার করা হয়েছে।' });
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
        return res.json({ success: true, message: 'অ্যাকাউন্ট সফলভাবে সক্রিয় করা হয়েছে!' });
    } catch (error) {
        try { await conn.close(); } catch (e) {}
        return res.status(500).json({ success: false, message: 'রাউটারে অ্যাকাউন্ট তৈরিতে ত্রুটি হয়েছে।' });
    }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
