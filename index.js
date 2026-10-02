const express = require('express');
const { RouterOSAPI } = require('node-routeros');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// CORS পলিসি
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  next();
});

// মিডলওয়্যার ও স্ট্যাটিক ফোল্ডার (ওয়েব পেজ দেখানোর জন্য)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.text({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// মেমোরি স্টোর
const pendingPayments = new Map();

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]:', reason);
});

// হোমপেজে ফ্রন্টএন্ড ফর্ম লোড হবে
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// MikroTik RouterOS v7 User Manager ইন্টিগ্রেশন
async function createUserManagerUser(username, password, profileName, commentText) {
  const api = new RouterOSAPI({
    host: process.env.MIKROTIK_HOST || '103.54.37.182',
    port: parseInt(process.env.MIKROTIK_PORT, 10) || 1126,
    user: process.env.MIKROTIK_USER || 'smsbot',
    password: process.env.MIKROTIK_PASSWORD || '66778',
    timeout: 10
  });

  try {
    await api.connect();
    // এখানে রাউটারে ইউজার তৈরির API কমান্ড রান হবে
    await api.write('/user-manager/user/add', [
      `=name=${username}`,
      `=password=${password}`,
      `=group=${profileName}`,
      `=comment=${commentText}`
    ]);
    await api.close();
    return true;
  } catch (err) {
    console.error('MikroTik API Error:', err);
    try { await api.close(); } catch (_) {}
    return false;
  }
}

// টাকার পরিমাণ অনুযায়ী MikroTik প্রোফাইল সিলেকশন
function getProfileByAmount(amount) {
  if (amount === 10) return 'Profile-1Hour';
  if (amount === 15) return 'Profile-12Hour';
  if (amount === 150) return 'Profile-30Day';
  if (amount === 200) return 'Profile-100GB';
  if (amount === 350) return 'Profile-300GB';
  return 'Profile-1Day'; // ডিফল্ট প্রোফাইল
}

// MacroDroid থেকে SMS রিসিভ করার এন্ডপয়েন্ট
app.all('/forward', async (req, res) => {
  let rawMessage = '';
  
  if (typeof req.body === 'string') {
    rawMessage = req.body;
  } else if (req.body && req.body.message) {
    rawMessage = req.body.message;
  } else if (req.query && req.query.message) {
    rawMessage = req.query.message;
  }

  const sender = (req.query?.sender || req.body?.sender || '').toString();

  console.log('--- Incoming SMS via MacroDroid ---');
  console.log('Raw Message:', rawMessage);
  console.log('Sender:', sender);

  // bKash / Nagad TrxID ও Amount বের করা
  const trxMatch = rawMessage.match(/(?:TrxID|TxnID|Transaction ID)[:\s]+([A-Z0-9]+)/i);
  const trxId = trxMatch ? trxMatch[1].trim().toUpperCase() : null;

  const amountMatch = rawMessage.match(/(?:Tk|BDT|amount)[:\s]*([0-9]+(?:\.[0-9]+)?)/i);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

  const phoneMatch = rawMessage.match(/(?:from|sender)[:\s]*(01[0-9]{9})/i);
  const customerNumber = phoneMatch ? phoneMatch[1] : '';

  const profile = getProfileByAmount(amount);

  if (trxId) {
    pendingPayments.set(trxId, {
      phone: customerNumber,
      amount: amount,
      profile: profile,
      time: Date.now()
    });

    console.log(`[PAYMENT STORED] TrxID: ${trxId}, Amount: ${amount}, Profile: ${profile}`);
  }

  return res.status(200).send('Logged for verification');
});

// কাস্টমার সাইন-আপ ও TrxID ভেরিফিকেশন এন্ডপয়েন্ট
app.post('/api/signup', async (req, res) => {
  const { username, password, trxId, phone } = req.body;
  const targetUser = (username || phone || '').trim();

  if (!targetUser || !password) {
    return res.status(400).json({
      success: false,
      message: 'মোবাইল নম্বর ও পাসওয়ার্ড আবশ্যক।'
    });
  }

  if (!trxId) {
    return res.status(400).json({
      success: false,
      message: 'বিকাশ/নগদ TrxID দেওয়া বাধ্যতামূলক।'
    });
  }

  const cleanTrx = trxId.trim().toUpperCase();
  const payment = pendingPayments.get(cleanTrx);

  if (!payment) {
    return res.status(400).json({
      success: false,
      message: 'ট্রানজেকশন আইডি মেলেনি অথবা পেমেন্টের এসএমএস এখনও সার্ভারে পৌঁছায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।'
    });
  }

  // পেমেন্ট অনুযায়ী MikroTik-এ ইউজার তৈরি
  const comment = `Web Signup Trx: ${cleanTrx}, Tk: ${payment.amount}`;
  const created = await createUserManagerUser(
    targetUser,
    password,
    payment.profile,
    comment
  );

  if (created) {
    pendingPayments.delete(cleanTrx); // একবার ব্যবহার হয়ে গেলে মুছে ফেলা হবে
    return res.json({
      success: true,
      message: `অ্যাকাউন্ট সক্রিয় হয়েছে! প্যাকেজ: ${payment.profile}`
    });
  } else {
    return res.status(500).json({
      success: false,
      message: 'রাউটারে অ্যাকাউন্ট তৈরি করতে ব্যর্থ হয়েছে।'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
