const express = require('express');
const RosApi = require('node-routeros').RouterOSAPI;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MikroTik এনভায়রনমেন্ট ভ্যারিয়েবল
const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD;
const MIKROTIK_PORT = parseInt(process.env.MIKROTIK_PORT, 10) || 8728;

// ট্রানজ্যাকশন মেমোরি স্টোর
const paymentStore = new Map();

// সম্পূর্ণ HTML ফর্ম সরাসরি রেন্ডার করা (কোনো 404 হবে না)
const HTML_PAGE = `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FAZ NETWORK - হটস্পট রেজিস্ট্রেশন</title>
    <style>
        body { font-family: Arial, sans-serif; background: #eef2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 15px; }
        .card { background: #fff; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); width: 100%; max-width: 400px; padding: 25px; box-sizing: border-box; }
        h2 { text-align: center; color: #1a73e8; margin-top: 0; }
        .info { background: #fff8e1; border-left: 4px solid #ffb300; padding: 10px; font-size: 13px; line-height: 1.5; margin-bottom: 15px; border-radius: 4px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; font-weight: bold; margin-bottom: 5px; font-size: 13px; }
        input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #1a73e8; color: #fff; border: none; border-radius: 6px; font-size: 15px; font-weight: bold; cursor: pointer; }
        button:hover { background: #1557b0; }
        .msg { margin-top: 15px; text-align: center; font-size: 14px; padding: 10px; border-radius: 6px; display: none; }
        .msg.error { display: block; background: #fde8e8; color: #c81e1e; }
        .msg.success { display: block; background: #def7ec; color: #03543f; }
    </style>
</head>
<body>
<div class="card">
    <h2>FAZ NETWORK</h2>
    <div class="info">
        ১. বিকাশ / নগদ (Send Money): <b>01339932887</b><br>
        ২. পেমেন্ট সম্পন্ন করে ফিরতি SMS-এর <b>TrxID</b> নিচে দিন।
    </div>
    <form id="signupForm">
        <div class="form-group">
            <label>মোবাইল নম্বর (ইউজারনেম)</label>
            <input type="text" id="username" required placeholder="017xxxxxxxx">
        </div>
        <div class="form-group">
            <label>পাসওয়ার্ড</label>
            <input type="password" id="password" required placeholder="পাসওয়ার্ড দিন">
        </div>
        <div class="form-group">
            <label>bKash / Nagad TrxID</label>
            <input type="text" id="trxId" required placeholder="যেমন: BLG485..." style="text-transform: uppercase;">
        </div>
        <button type="submit" id="btn">অ্যাকাউন্ট ভেরিফাই ও চালু করুন</button>
    </form>
    <div id="statusMsg" class="msg"></div>
</div>
<script>
document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn');
    const msg = document.getElementById('statusMsg');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const trxId = document.getElementById('trxId').value.trim();

    btn.disabled = true;
    btn.innerText = 'ভেরিফাই করা হচ্ছে...';
    msg.className = 'msg';
    msg.style.display = 'none';

    try {
        const res = await fetch('/api/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, trxId })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            msg.className = 'msg success';
            msg.innerText = data.message;
            document.getElementById('signupForm').reset();
        } else {
            msg.className = 'msg error';
            msg.innerText = data.message || 'ব্যর্থ হয়েছে!';
        }
    } catch (err) {
        msg.className = 'msg error';
        msg.innerText = 'সার্ভারে সংযোগ করা সম্ভব হচ্ছে না।';
    } finally {
        btn.disabled = false;
        btn.innerText = 'অ্যাকাউন্ট ভেরিফাই ও চালু করুন';
    }
});
</script>
</body>
</html>`;

// হোমপেজে সরাসরি ফর্ম পাঠানো
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(HTML_PAGE);
});

// হেলথ চেক
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running', service: 'FAZ NETWORK' });
});

// MacroDroid SMS Webhook
app.post('/api/sms-webhook', (req, res) => {
    const { message, sender } = req.body;
    if (!message) return res.status(400).json({ success: false });

    console.log(`[SMS Received] ${sender}: ${message}`);
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

// সাইন-আপ API (User Manager এ ইউজার তৈরি)
app.post('/api/signup', async (req, res) => {
    const { username, password, trxId } = req.body;
    if (!username || !password || !trxId) {
        return res.status(400).json({ success: false, message: 'সবকটি তথ্য সঠিকভাবে দিন।' });
    }

    const cleanTrx = trxId.trim().toUpperCase();
    const payment = paymentStore.get(cleanTrx);

    if (!payment) {
        return res.status(400).json({ success: false, message: 'ভুল ট্রানজ্যাকশন আইডি অথবা পেমেন্টের এসএমএস এখনও আসেনি।' });
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
        return res.json({ success: true, message: 'আপনার ইন্টারনেট অ্যাকাউন্ট সফলভাবে সক্রিয় করা হয়েছে!' });
    } catch (error) {
        try { await conn.close(); } catch (e) {}
        return res.status(500).json({ success: false, message: 'রাউটারে ইউজার তৈরিতে ত্রুটি হয়েছে।' });
    }
});

app.listen(PORT, () => {
    console.log(`FAZ NETWORK Server is running on port ${PORT}`);
});
