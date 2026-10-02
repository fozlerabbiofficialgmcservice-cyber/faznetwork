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
        port: 1102,
        user: 'smsbot',
        password: '66778'
    });

    try {
        await api.connect();
        
        await api.write('/user-manager/user/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=comment=${commentText}`
        ]);

        await api.write('/user-manager/user-profile/add', [
            `=user=${username}`,
            `=profile=${profileName}`
        ]);

        console.log(`[SUCCESS] User Created: ${username} | Profile: ${profileName}`);
    } catch (err) {
        console.error('[ERROR] MikroTik User Manager API Error:', err.message || err);
    } finally {
        api.close();
    }
}

app.all('/forward', async (req, res) => {
    const rawMessage = (req.query.message || req.body?.message || (typeof req.body === 'string' ? req.body : '') || '').toString();
    const sender = (req.query.sender || req.body?.sender || '').toString();

    console.log('--- Incoming Request ---');
    console.log('Raw Message:', rawMessage);
    console.log('Sender:', sender);

    const amountMatch = rawMessage.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    const phoneMatch = rawMessage.match(/(?:from|sender)\s*(?:01|\+?8801)(\d{9})/i) || rawMessage.match(/(01[3-9]\d{8})/);
    const customerNumber = phoneMatch ? ('01' + (phoneMatch[1] || phoneMatch[0].slice(-9))) : (sender ? sender.replace(/[^0-9]/g, '') : null);

    const trxMatch = rawMessage.match(/TrxID\s+([A-Z0-9]+)/i);
    const trxId = trxMatch ? trxMatch[1] : 'Manual';

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

    if (customerNumber && profile) {
        const comment = `bKash/Nagad Trx: ${trxId}, Tk: ${amount}`;
        await createUserManagerUser(customerNumber, customerNumber, profile, comment);
    }

    res.status(200).send('Processed');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
