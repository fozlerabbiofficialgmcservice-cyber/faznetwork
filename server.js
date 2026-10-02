// JSON, URL-encoded এবং Plain Text সব ধরণের SMS ধরার ব্যবস্থা
app.use(express.text({ type: '*/*' }));

app.post(['/api/sms-webhook', '/forward'], (req, res) => {
    let message = '';
    let sender = 'Unknown';

    // JSON বডি অথবা প্লেইন টেক্সট ডিটেক্ট করা
    if (typeof req.body === 'object' && req.body !== null) {
        message = req.body.message || JSON.stringify(req.body);
        sender = req.body.sender || 'Unknown';
    } else if (typeof req.body === 'string') {
        message = req.body;
    }

    console.log(`[SMS Hit Received] Sender: ${sender}, Message: ${message}`);

    if (!message) {
        return res.status(400).json({ success: false, message: 'SMS খালি ছিল।' });
    }

    // বিকাশ ও নগদ TrxID রেগুলার এক্সপ্রেশন
    const trxMatch = message.match(/(?:TrxID|TxnID|Txn ID|Transaction ID)[:\s]*([A-Z0-9]+)/i);
    const amountMatch = message.match(/(?:Tk|BDT|amount)[:\s]*([\d,]+(?:\.\d{2})?)/i);

    if (trxMatch && trxMatch[1]) {
        const trxId = trxMatch[1].trim().toUpperCase();
        const amount = amountMatch ? amountMatch[1].replace(/,/g, '') : '0';

        paymentStore.set(trxId, {
            sender: sender,
            amount: amount,
            used: false,
            timestamp: Date.now()
        });

        console.log(`[SAVED] TrxID: ${trxId} | Amount: ${amount}`);
        return res.status(200).json({ success: true, trxId: trxId, amount: amount });
    }

    console.log('[REJECTED] কোনো TrxID খুঁজে পাওয়া যায়নি।');
    return res.status(200).json({ success: false, message: 'মেসেজে TrxID পাওয়া যায়নি।' });
});
