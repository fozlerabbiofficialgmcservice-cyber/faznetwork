const express = require('express');
const { RouterOSClient } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 8080;

// সব ফরম্যাট (JSON, Form Data, Plain Text) সাপোর্ট করার জন্য
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

app.get('/', (req, res) => {
    res.send('FAZ Network User Manager Server is Running!');
});

// User Manager-এ ইউজার ও প্রোফাইল তৈরি ফাংশন
async function createUserManagerUser(username, password, profileName, commentText) {
    const client = new RouterOSClient({
        host: '103.54.37.182',
        port: 1102,
        user: 'smsbot',
        password: '66778' // মাইক্রোটিকে আপনার smsbot ইউজারের আসল পাসওয়ার্ড দিন
    });

    try {
        await client.connect();

        // ১. User Manager-এ নতুন ইউজার তৈরি
        await client.write('/user-manager/user/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=comment=${commentText}`
        ]);

        // ২. ইউজারের ওপর প্রোফাইল অ্যাসাইন করা
        await client.write('/user-manager/user-profile/add', [
            `=user=${username}`,
            `=profile=${profileName}`
        ]);

        console.log(`[SUCCESS] User Created: ${username} | Profile: ${profileName} | Ref: ${commentText}`);
    } catch (err) {
        console.error('[ERROR] MikroTik User Manager API Error:', err.message || err);
    } finally {
        client.close();
    }
}

// MacroDroid থেকে ডাটা রিসিভ করার এন্ডপয়েন্ট
app.all('/forward', async (req, res) => {
    // বডি অথবা কুয়েরি প্যারামিটার যেকোনো এক জায়গা থেকে ডাটা নেওয়া
    const body = req.body || {};
    const query = req.query || {};

    let rawMessage = body.message || query.message || '';
    let sender = body.sender || query.sender || '';

    // যদি পুরো বডি সরাসরি টেক্সট স্ট্রিং হিসেবে আসে
    if (typeof req.body === 'string' && !rawMessage) {
        try {
            const parsed = JSON.parse(req.body);
            rawMessage = parsed.message || '';
            sender = parsed.sender || '';
        } catch (e) {
            rawMessage = req.body;
        }
    }

    console.log('--- Incoming Request ---');
    console.log('Raw Message:', rawMessage);
    console.log('Sender:', sender);

    // ১. টাকার পরিমাণ বের করা
    const amountMatch = rawMessage.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    // ২. গ্রাহকের ১১ ডিজিটের নম্বর বের করা (from 01XXXXXXXXX বা টেক্সটে থাকা 01XXXXXXXXX)
    const phoneMatch = rawMessage.match(/(?:from|sender)\s*(?:01|\+?8801)(\d{9})/i) || rawMessage.match(/(01[3-9]\d{8})/);
    const customerNumber = phoneMatch ? ('01' + (phoneMatch[1] || phoneMatch[0].slice(-9))) : (sender ? sender.replace(/[^0-9]/g, '') : null);

    // ৩. TrxID বের করা
    const trxMatch = rawMessage.match(/TrxID\s+([A-Z0-9]+)/i);
    const trxId = trxMatch ? trxMatch[1] : 'Manual';

    console.log(`Parsed Data -> Amount: ${amount}, Phone: ${customerNumber}, TrxID: ${trxId}`);

    // ৪. আপনার User Manager প্রোফাইল অনুযায়ী প্যাকেজ
    let profile = null;
    if (amount === 10) profile = 'Profile - 1Hour';
    else if (amount === 15) profile = 'Profile - 12Hour';
    else if (amount === 20) profile = 'Profile - 1Day';
    else if (amount === 40) profile = 'Profile - 3Day';
    else if (amount === 60) profile = 'Profile - 7Day';
    else if (amount === 90) profile = 'Profile - 15Day';
    else if (amount === 150) profile = 'Profile - 30Day';
    else if (amount === 200) profile = 'Profile - 100GB';
    else if (amount === 350) profile = 'Profile - 300GB';

    // ৫. ইউজার তৈরি করা
    if (customerNumber && profile) {
        const comment = `bKash/Nagad Trx: ${trxId}, Tk: ${amount}`;
        await createUserManagerUser(customerNumber, customerNumber, profile, comment);
    } else {
        console.log(`[SKIPPED] Missing valid phone or matching package for amount ${amount}`);
    }

    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
