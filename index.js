const express = require('express');
const { RouterOSAPI } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.text({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
            await api.write('/user-manager/user/add', [
                `=name=${username}`,
                `=password=${password}`,
                `=comment=${commentText}`,
                '=group=Hotspot',
                '=disabled=no'
            ]);
            console.log(`[USER ADDED] ${username}`);
        } else {
            await api.write('/user-manager/user/set', [
                `=.id=${existingUsers[0]['.id']}`,
                `=password=${password}`,
                `=comment=${commentText}`
            ]);
            console.log(`[USER UPDATED] ${username}`);
        }

        // ২. প্রোফাইল যুক্ত করা
        await api.write('/user-manager/user-profile/add', [
            `=user=${username}`,
            `=profile=${profileName}`
        ]);

        console.log(`[SUCCESS] Profile '${profileName}' assigned to: ${username}`);

    } catch (err) {
        console.error('[ERROR DETAILS]:', err);
    } finally {
        try {
            await api.close();
        } catch (_) {}
    }
}

app.all('/forward', async (req, res) => {
    let rawMessage = '';
    
    if (req.query && req.query.message) {
        rawMessage = String(req.query.message);
    } else if (typeof req.body === 'string' && req.body.trim().length > 0) {
        rawMessage = req.body;
    } else if (req.body && req.body.message) {
        rawMessage = String(req.body.message);
    } else if (req.body && Object.keys(req.body).length > 0) {
        rawMessage = JSON.stringify(req.body);
    }

    const sender = (req.query?.sender || req.body?.sender || '').toString();

    console.log('--- Incoming Request ---');
    console.log('Raw Message:', rawMessage);
    console.log('Sender:', sender);

    // ১. টাকার পরিমাণ বের করা
    const amountMatch = rawMessage.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? Math.round(parseFloat(amountMatch[1].replace(',', ''))) : 0;

    // ২. গ্রাহকের ১১ ডিজিটের নম্বর বের করা
    const phoneMatch = rawMessage.match(/(01[3-9]\d{8})/);
    let customerNumber = null;
    if (phoneMatch) {
        customerNumber = phoneMatch[1];
    } else if (sender) {
        const cleanSender = sender.replace(/[^0-9]/g, '');
        if (cleanSender.length >= 11) {
            customerNumber = cleanSender.slice(-11);
        }
    }

    // ৩. TrxID বের করা
    const trxMatch = rawMessage.match(/TrxID[:\s]+([A-Z0-9]+)/i);
    const trxId = trxMatch ? trxMatch[1] : 'Manual';

    // ৪. সঠিক প্রোফাইল নির্ধারণ
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

    console.log(`Parsed Data -> Phone: ${customerNumber}, Amount: ${amount}, Profile: ${profile}`);

    if (customerNumber && profile) {
        const comment = `bKash/Nagad Trx: ${trxId}, Tk: ${amount}`;
        await createUserManagerUser(customerNumber, customerNumber, profile, comment);
        return res.status(200).send(`OK: Processed for ${customerNumber}`);
    } else {
        console.warn(`[IGNORED] Data incomplete or invalid amount`);
        return res.status(200).send('Ignored: Data incomplete');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
