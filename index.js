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
        host: '103.54.37.182',
        port: 1102,
        user: 'smsbot',
        password: 'YourBotPassword123'
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

    // টাকা অনুযায়ী MikroTik হটস্পট প্রোফাইল
    let profile = 'default';
    if (amount >= 10 && amount < 50) {
        profile = '1day';
    } else if (amount >= 50) {
        profile = '30days';
    }

    // প্রেরকের ফোন নম্বর থেকে ইউজারনেম তৈরি
    const username = sender.replace(/[^0-9]/g, '');
    const password = Math.floor(1000 + Math.random() * 9000).toString();

    if (username) {
        await createHotspotUser(username, password, profile);
    }

    res.status(200).send('Message processed');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
