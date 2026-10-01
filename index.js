const express = require('express');
const { RouterOSClient } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// MikroTik-এ ইউজার তৈরির ফাংশন
async function createHotspotUser(username, password, profileName) {
    const client = new RouterOSClient({
        host: 'YOUR_MIKROTIK_VPN_IP', // আপনার VPN বা পাবলিক আইপি/DDNS
        user: 'smsbot',               // ধাপ ২ এ তৈরি করা ইউজার
        password: 'YourBotPassword123', // ধাপ ২ এ দেওয়া পাসওয়ার্ড
        port: 8728
    });

    try {
        await client.connect();
        await client.write('/ip/hotspot/user/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=profile=${profileName}` // আপনার হটস্পট প্রোফাইলের নাম (যেমন: 1day, 30days)
        ]);
        console.log(`Hotspot user created: ${username}`);
    } catch (err) {
        console.error('MikroTik Error:', err);
    } finally {
        client.close();
    }
}

app.post('/forward', async (req, res) => {
    console.log('Received data:', req.body);

    const message = req.body.message || '';
    const sender = req.body.sender || '';

    // বিকাশ/নগদ এসএমএস থেকে টাকার পরিমাণ বের করা (উদাহরণ: Tk 10.00 বা 10Tk)
    const amountMatch = message.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    // টাকার পরিমাণ অনুযায়ী হটস্পট প্রোফাইল নির্ধারণ
    let profile = 'default';
    if (amount >= 10 && amount < 50) {
        profile = '1day';
    } else if (amount >= 50) {
        profile = '30days';
    }

    // ইউজারনেম হিসেবে গ্রাহকের ফোন নম্বর ও পিন তৈরি
    const username = sender.replace(/[^0-9]/g, ''); // গ্রাহকের নম্বর
    const password = Math.floor(1000 + Math.random() * 9000).toString(); // ৪ ডিজিট পিন

    if (username) {
        await createHotspotUser(username, password, profile);
    }

    res.status(200).send('Message processed');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
