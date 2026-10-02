const express = require('express');
const { RouterOSAPI } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

app.get('/', (req, res) => {
    res.send('FAZ Network User Manager Server is Running!');
});

async function createUserManagerUser(username, password, profileName, commentText) {
    const api = new RouterOSAPI({
        host: '103.54.37.182',
        port: 8728,
        user: 'smsbot',
        password: '66778',
        timeout: 10
    });

    try {
        await api.connect();

        // ১. চেক করা ইউজার আগে থেকে আছে কিনা
        const existingUsers = await api.write('/user-manager/user/print', [
            `?name=${username}`
        ]);

        if (!existingUsers || existingUsers.length === 0) {
            // নতুন ইউজার তৈরি
            await api.write('/user-manager/user/add', [
                `=name=${username}`,
                `=password=${password}`,
                `=comment=${commentText}`,
                '=group=Hotspot',
                '=disabled=no'
            ]);
            console.log(`[USER ADDED] ${username}`);
        } else {
            // আগে থেকে থাকলে আপডেট
            await api.write('/user-manager/user/set', [
                `=.id=${existingUsers[0]['.id']}`,
                `=password=${password}`,
                `=comment=${commentText}`
            ]);
            console.log(`[USER UPDATED] ${username}`);
        }

        // ২. প্রোফাইল অ্যাসাইন করা
        await api.write('/user-manager/user-profile/add', [
            `=user=${username}`,
            `=profile=${profileName}`
        ]);

        console.log(`[SUCCESS] Profile '${profileName}' assigned to: ${username}`);

    } catch (err) {
        console.error('[ERROR DETAILS]:', err.r ? err.r() : (err.message || err));
    } finally {
        try {
            await api.close();
        } catch (_) {}
    }
}

app.all('/forward', async (req, res) => {
    let rawMessage = '';
    if (typeof req.body === 'string') {
        rawMessage = req.body;
    } else if (req.body && typeof req.body === 'object') {
        rawMessage = req.body.message ? String(req.body.message) : JSON.stringify(req.body);
    } else if (req.query && req.query.message) {
        rawMessage = String(req.query.message);
    }

    const sender = (req.query.sender || req.body?.sender || '').toString();

    console.log('--- Incoming Request ---');
    console.log('Raw Message:', rawMessage);
    console.log('Sender:', sender);

    // টাকার পরিমাণ বের করা
    const amountMatch = rawMessage.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    // ফোন নম্বর বের করা
    const phoneMatch = rawMessage.match(/(?:from|sender)\s*[:]?\s*(?:\+?88)?(01[3-9]\d{8})/i) || rawMessage.match(/(01[3-9]\d{8})/);
    let customerNumber = null;
    if (phoneMatch) {
        customerNumber = phoneMatch[1] || phoneMatch[0];
    } else if (sender) {
        const cleanSender = sender.replace(/[^0-9]/g, '');
        if (cleanSender.length >= 11) {
            customerNumber = cleanSender.slice(-11);
        }
    }

    // TrxID বের করা
    const trxMatch = rawMessage.match(/TrxID[:\s]+([A-Z0-9]+)/i);
    const trxId = trxMatch ? trxMatch[1] : 'Manual';

    // MikroTik Profiles অনুযায়ী সঠিক নামের ম্যাপিং (কোনো স্পেস নেই)
    let profile = null;
    if (amount === 10) profile = 'Profile-1Hour';
    else if (amount === 15) profile = 'Profile-12Hour';
    else if (amount === 20) profile = 'Profile-1Day';
    else if (amount === 40) profile = 'Profile-3Day';
    else if (amount === 60) profile = 'Profile-7Day';
    else if (amount === 90) profile = 'Profile-15Day';
    else if (amount === 150) profile = 'Profile-30Day';
    else if (amount === 200) profile = 'Profile-100GB';
    else if (amount === 350) profile = 'Profile-300GB';

    if (customerNumber && profile) {
        const comment = `bKash/Nagad Trx: ${trxId}, Tk: ${amount}`;
        await createUserManagerUser(customerNumber, customerNumber, profile, comment);
        return res.status(200).send(`SUCCESS: User ${customerNumber} processed with ${profile}`);
    } else {
        console.warn(`[SKIPPED] Missing data: Phone=${customerNumber}, Amount=${amount}, Profile=${profile}`);
        return res.status(400).send('ERROR: Invalid amount or customer number');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
