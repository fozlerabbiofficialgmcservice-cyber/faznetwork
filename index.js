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
        password: '66778'
    });

    try {
        await api.connect();

        await api.write('/user-manager/user/add', [
            `=name=${username}`,
            `=password=${password}`,
            `=comment=${commentText}`,
            '=disabled=no'
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
    const rawMessage = (req.query.message || req.body?.message || typeof req.body === 'string' ? req.body : '').toString();
    const sender = (req.query.sender || req.body?.sender || '').toString();

    console.log('--- Incoming Request ---');
    console.log('Raw Message:', rawMessage);
    console.log('Sender:', sender);

    const amountMatch = rawMessage.match(/(?:Tk|BDT)\s*([\d,.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : 0;

    const phoneMatch = rawMessage.match(/(?:from|sender)\s*(?:\+?01|\+?8801|\+88|\b01(?:\d{8}))/i) || rawMessage.match(/(01[3-9]\d{8})/);
    const customerNumber = phoneMatch ? ('01' + (phoneMatch[1] || phoneMatch[0]).slice(-9)) : (sender ? sender.replace(/[^0-9]/g, '').slice(-9) : null);

    const trxMatch = rawMessage.match(/(TrxID\s*([A-Z0-9]+))/i);
    const trxId = trxMatch ? trxMatch[2] : 'Manual';

    let profile = null;

    if (amount === 10) profile = '1Hour';
    else if (amount === 15) profile = '12Hour';
    else if (amount === 20) profile = '1Day';
    else if (amount === 40) profile = '3Day';
    else if (amount === 60) profile = '7Day';
    else if (amount === 90) profile = '15Day';
    else if (amount === 150) profile = '30Day';
    else if (amount === 200) profile = '100GB';
    else if (amount === 350) profile = '200GB';

    if (profile && customerNumber) {
        await createUserManagerUser(customerNumber, customerNumber, profile, `TrxID: ${trxId}`);
        res.status(200).send('SUCCESS: User added to User Manager');
    } else {
        res.status(400).send('ERROR: Invalid amount or phone number');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
