const express = require('express');
const { RouterOSClient } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// হোম রুট চেক করার জন্য
app.get('/', (req, res) => {
    res.send('FAZ Network SMS-to-MikroTik Server is running smoothly!');
});

// MikroTik-এ হটস্পট ইউজার তৈরি করার ফাংশন
async function createHotspotUser(username, password, profileName, commentText) {
    const client = new RouterOSClient({
        host: '103.54.37.182',          // আপনার ভিপিএন আইপি
        port: 1102,                    // আপনার পোর্ট
        user: 'smsbot',                // মাইক্রোটিকে তৈরি করা API ইউজারনেম
        password: 'YourBotPassword123'  // মাইক্রোটিকে smsbot ইউজারের পাসওয়ার্ড
    });

    try {
        await client.connect();
        await client.write('/ip/hotspot/user/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=profile=${profileName}`,
            `=comment=${commentText}`
        ]);
        console.log(`[SUCCESS] Hotspot User Created: ${username} | Profile: ${profileName} | Ref: ${commentText}`);
    } catch (err) {
        console.error('[ERROR] MikroTik API Error:', err.message || err);
    } finally {
        client.close();
    }
}

// MacroDroid থেকে ডাটা রিসিভ করার এন্ডপয়েন্ট
app.post('/forward', async (req, res) => {
    console.log('Received SMS Data:', req.body);

    const message = req.body.message || '';

    // ১. এসএমএস থেকে টাকার পরিমাণ বের করা (Tk বা BDT এর পর সংখ্যা)
    const amountMatch = message.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    // ২. এসএমএস থেকে গ্রাহকের ১১ ডিজিটের নম্বর বের করা (from 01XXXXXXXXX)
    const phoneMatch = message.match(/(?:from|sender)\s*(?:01|\+?8801)(\d{9})/i) || message.match(/(01[3-9]\d{8})/);
    const customerNumber = phoneMatch ? ('01' + (phoneMatch[1] || phoneMatch[0].slice(-9))) : null;

    // ৩. এসএমএস থেকে TrxID বের করা
    const trxMatch = message.match(/TrxID\s+([A-Z0-9]+)/i);
    const trxId = trxMatch ? trxMatch[1] : 'Manual';

    console.log(`Parsed Data -> Amount: ${amount}, Phone: ${customerNumber}, TrxID: ${trxId}`);

    // ৪. টাকার পরিমাণ অনুযায়ী আপনার MikroTik হটস্পট প্রোফাইল নির্ধারণ
    let profile = 'default';
    if (amount >= 10 && amount < 50) {
        profile = '1day';    // MikroTik-এর প্রোফাইল নাম হুবহু মিল থাকতে হবে
    } else if (amount >= 50) {
        profile = '30days';  // MikroTik-এর প্রোফাইল নাম হুবহু মিল থাকতে হবে
    }

    // ৫. মাইক্রোটিকে ইউজার তৈরি করা
    if (customerNumber && amount > 0) {
        const comment = `bKash/Nagad Trx: ${trxId}, Tk: ${amount}`;
        // ইউজারনেম এবং পাসওয়ার্ড দুটিই গ্রাহকের ফোন নম্বর রাখা হয়েছে
        await createHotspotUser(customerNumber, customerNumber, profile, comment);
    } else {
        console.log('[SKIPPED] Valid phone number or amount not found in SMS.');
    }

    res.status(200).send('Message processed successfully');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
