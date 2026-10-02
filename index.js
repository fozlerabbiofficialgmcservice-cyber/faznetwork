const express = require('express');
const RosApi = require('node-routeros').RouterOSAPI;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ১. MikroTik কানেকশন ডিটেইলস (সরাসরি কোডে)
const MIKROTIK_CONFIG = {
    host: 'YOUR_ROUTER_IP_OR_DDNS', // আপনার রাউটারের আইপি / ডোমেন
    user: 'admin',                 // রাউটারের ইউজার
    password: 'YOUR_PASSWORD',      // রাউটারের পাসওয়ার্ড
    port: 8728,                    // এপিআই পোর্ট
    timeout: 10
};

// ২. প্যাকেজ রেট ও User Manager প্রোফাইল ম্যাপিং
const PACKAGES = {
    10: '1_Hour',
    20: '1_Day',
    50: '3_Days',
    100: '7_Days',
    300: '30_Days',
    500: '1_Month'
};

// ডুপ্লিকেট ট্রানজেকশন ঠেকানোর রেকর্ড
const processedTrx = new Set();

// MikroTik User Manager-এ ইউজার ক্রিয়েট ফাংশন
async function createUserManagerUser(phone, profileName, trxId) {
    const conn = new RosApi(MIKROTIK_CONFIG);
    try {
        await conn.connect();
        
        // RouterOS v7 User Manager কমান্ড
        await conn.write('/user-manager/user/add', [
            `=name=${phone}`,
            `=password=${phone.slice(-4)}`,
            `=comment=TrxID:${trxId}`,
            `=attributes=phone:${phone}`
        ]);

        await conn.write('/user-manager/user-profile/add', [
            `=user=${phone}`,
            `=profile=${profileName}`
        ]);

        await conn.close();
        return true;
    } catch (err) {
        if (conn) {
            try { await conn.close(); } catch (e) {}
        }
        throw err;
    }
}

// সার্ভিস লাইভ চেক রুট
app.get('/', (req, res) => {
    res.status(200).send('FAZ NETWORK SMS Gateway Running...');
});

// মূল SMS Webhook রুট
app.post('/', async (req, res) => {
    try {
        const text = req.body.message || req.body.text || req.body.content || req.body.msg || "";
        console.log("রিসিভড এসএমএস:", text);

        if (!text) {
            return res.status(400).send("No message text received");
        }

        // ক. TrxID বের করা
        const trxMatch = text.match(/(?:TrxID|TxnID|Trx)\s*[:]?\s*([A-Za-z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1] : null;

        // খ. টাকার পরিমাণ বের করা
        const amountMatch = text.match(/(?:Tk|BDT|amount)\s*[:]?\s*([0-9]+(?:\.[0-9]+)?)/i) || 
                            text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:Tk|BDT)/i);
        const amount = amountMatch ? Math.floor(parseFloat(amountMatch[1])) : null;

        // গ. ফোন নম্বর বের করা
        const phoneMatch = text.match(/(01[3-9][0-9]{8})/);
        const customerPhone = phoneMatch ? phoneMatch[1] : null;

        if (!trxId || !customerPhone || !amount) {
            return res.status(400).send("Parsing failed: TrxID, Amount, or Phone missing");
        }

        if (processedTrx.has(trxId)) {
            return res.status(200).send("Duplicate transaction ignored");
        }

        const profile = PACKAGES[amount];
        if (!profile) {
            return res.status(400).send(`No package found for amount: ${amount}`);
        }

        // MikroTik-এ ইউজার তৈরি
        await createUserManagerUser(customerPhone, profile, trxId);
        processedTrx.add(trxId);

        console.log(`[SUCCESS] User: ${customerPhone} created with profile: ${profile}`);
        return res.status(200).send("OK - User Created");

    } catch (error) {
        console.error("ত্রুটি:", error.message);
        return res.status(500).send(error.message);
    }
});

app.listen(PORT, () => {
    console.log(`FAZ NETWORK Server Running on Port ${PORT}`);
});
