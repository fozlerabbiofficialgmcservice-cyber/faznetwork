const express = require('express');
const { RouterOSClient } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 8080;

// সব ধরনের বডি ফরম্যাট হ্যান্ডেল করার জন্য মিডলওয়্যার
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

app.get('/', (req, res) => {
    res.send('FAZ Network User Manager Auto-Voucher Server is running!');
});

// User Manager-এ ইউজার ও প্রোফাইল তৈরি করার ফাংশন
async function createUserManagerUser(username, password, profileName, commentText) {
    const client = new RouterOSClient({
        host: '103.54.37.182',
        port: 1102,
        user: 'smsbot',
        password: '66778' // মাইক্রোটিকে আপনার smsbot ইউজারের পাসওয়ার্ড
    });

    try {
        await client.connect();

        // ১. User Manager-এ নতুন ইউজার তৈরি
        await client.write('/user-manager/user/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=comment=${commentText}`
        ]);

        // ২. ইউজারের ওপর নির্বাচিত প্রোফাইল অ্যাসাইন করা
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

// MacroDroid থেকে আসা ডেটা প্রসেস করার রুট
app.post('/forward', async (req, res) => {
    let bodyData = req.body;

    // বডি যদি কোনো কারণে প্লেইন টেক্সট স্ট্রিং হিসেবে আসে
    if (typeof bodyData === 'string') {
        try {
            bodyData = JSON.parse(bodyData);
        } catch (e) {
            console.log('Parsing plain text data:', bodyData);
            bodyData = { message: bodyData, sender: '' };
        }
    }

    console.log('Received SMS Data:', bodyData);

    const message = bodyData.message || (typeof bodyData === 'string' ? bodyData : '');

    // ১. এসএমএস থেকে টাকার পরিমাণ বের করা
    const amountMatch = message.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    // ২. এসএমএস থেকে গ্রাহকের ১১ ডিজিটের নম্বর বের করা
    const phoneMatch = message.match(/(?:from|sender)\s*(?:01|\+?8801)(\d{9})/i) || message.match(/(01[3-9]\d{8})/);
    const customerNumber = phoneMatch ? ('01' + (phoneMatch[1] || phoneMatch[0].slice(-9))) : null;

    // ৩. এসএমএস থেকে TrxID বের করা
    const trxMatch = message.match(/TrxID\s+([A-Z0-9]+)/i);
    const trxId = trxMatch ? trxMatch[1] : 'Manual';

    console.log(`Parsed Data -> Amount: ${amount}, Phone: ${customerNumber}, TrxID: ${trxId}`);

    // ৪. আপনার User Manager প্রোফাইল অনুযায়ী প্যাকেজ নির্বাচন
    let profile = null;
    if (amount === 10) {
        profile = 'Profile - 1Hour';
    } else if (amount === 15) {
        profile = 'Profile - 12Hour';
    } else if (amount === 20) {
        profile = 'Profile - 1Day';
    } else if (amount === 40) {
        profile = 'Profile - 3Day';
    } else if (amount === 60) {
        profile = 'Profile - 7Day';
    } else if (amount === 90) {
        profile = 'Profile - 15Day';
    } else if (amount === 150) {
        profile = 'Profile - 30Day';
    } else if (amount === 200) {
        profile = 'Profile - 100GB';
    } else if (amount === 350) {
        profile = 'Profile - 300GB';
    }

    // ৫. ভ্যালিড নম্বর ও প্যাকেজ পেলে ইউজার তৈরি করা
    if (customerNumber && profile) {
        const comment = `bKash/Nagad Trx: ${trxId}, Tk: ${amount}`;
        // ইউজারনেম এবং পাসওয়ার্ড উভয়ই গ্রাহকের ফোন নম্বর রাখা হয়েছে
        await createUserManagerUser(customerNumber, customerNumber, profile, comment);
    } else {
        console.log(`[SKIPPED] Phone: ${customerNumber}, Amount: ${amount} (Matched Profile: ${profile})`);
    }

    res.status(200).send('Message processed successfully');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
