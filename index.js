const express = require('express');
const { RouterOSClient } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.get('/', (req, res) => {
    res.send('Server is running smoothly!');
});
// MikroTik-এ হটস্পট ইউজার তৈরি করার ফাংশন
async function createHotspotUser(username, password, profileName) {
    const client = new RouterOSClient({
        host: '103.54.37.182',     // আপনার দেওয়া ভিপিএন রিয়েল আইপি
        port: 1102,               // আপনার দেওয়া পোর্ট
        user: 'smsbot',           // মাইক্রোটিকে তৈরি করা API ইউজারনেম
        password: 'YourBotPassword123' // মাইক্রোটিকে তৈরি করা পাসওয়ার্ড
    });

    try {
        await client.connect();
        await client.write('/ip/hotspot/user/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=profile=${profileName}`
        ]);
        console.log(`Hotspot user created: ${username} (Profile: ${profileName})`);
    } catch (err) {
        console.error('MikroTik API Error:', err);
    } finally {
        client.close();
    }
}

app.post('/forward', async (req, res) => {
    console.log('Received SMS Data:', req.body);

    const message = req.body.message || '';
    const sender = req.body.sender || '';

    // এসএমএস থেকে টাকার পরিমাণ বের করা
    const amountMatch = message.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    // টাকা অনুযায়ী আপনার MikroTik হটস্পট প্রোফাইলের নাম দিন
    let profile = 'default';
    if (amount >= 10 && amount < 50) {
        profile = '1day';    // MikroTik-এর হটস্পট প্রোফাইল নাম
    } else if (amount >= 50) {
        profile = '30days';  // MikroTik-এর হটস্পট প্রোফাইল নাম
    }

    // প্রেরকের ফোন নম্বর থেকে ইউজারনেম তৈরি
    const username = sender.replace(/[^0-9]/g, '');
    const password = Math.floor(1000 + Math.random() * 9000).toString(); // ৪ ডিজিট র‍্যান্ডম পিন

    if (username) {
        await createHotspotUser(username, password, profile);
    }

    res.status(200).send('Message processed');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
