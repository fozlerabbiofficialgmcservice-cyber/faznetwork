// কাস্টমার তালিকা (উন্নত ও ফলব্যাক হ্যান্ডলিং সহ)
app.get('/api/admin/customers', async (req, res) => {
    try {
        let customers = loadJSON(CUSTOMERS_FILE);
        if (!customers || typeof customers !== 'object') customers = {};

        let activeUsers = [];
        let secrets = [];

        try {
            [activeUsers, secrets] = await Promise.all([
                executeSingleCommand(['/ppp/active/print']),
                executeSingleCommand(['/ppp/secret/print'])
            ]);
        } catch (mkErr) {
            console.error('[MIKROTIK FETCH WARNING]:', mkErr.message);
        }

        const activeMap = {};
        if (Array.isArray(activeUsers)) {
            activeUsers.forEach(u => {
                const uname = u.name || u['=name'];
                if (uname) {
                    activeMap[uname] = {
                        uptime: u.uptime || u['=uptime'] || 'Online',
                        address: u.address || u['=address'] || 'N/A',
                        callerId: u['caller-id'] || u['=caller-id'] || ''
                    };
                }
            });
        }

        if (Array.isArray(secrets)) {
            secrets.forEach(sec => {
                const sName = sec.name || sec['=name'];
                if (!sName) return;

                let exp = null;
                const comment = sec.comment || sec['=comment'] || '';
                if (comment) {
                    const m = comment.match(/Exp:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
                    if (m) exp = m[1];
                }

                if (!customers[sName]) {
                    customers[sName] = {
                        name: sName,
                        username: sName,
                        password: sec.password || sec['=password'] || '1234',
                        connectionType: 'PPPoE',
                        phone: '',
                        profile: sec.profile || sec['=profile'] || 'Default',
                        bill: 500,
                        status: (sec.disabled === 'true' || sec['=disabled'] === 'true') ? 'suspended' : 'active',
                        expireDate: exp || '2026-11-05',
                        callerId: sec['caller-id'] || sec['=caller-id'] || '',
                        history: []
                    };
                } else {
                    customers[sName].callerId = sec['caller-id'] || sec['=caller-id'] || customers[sName].callerId || '';
                    customers[sName].profile = sec.profile || sec['=profile'] || customers[sName].profile;
                }
            });
        }

        const today = new Date().toISOString().split('T')[0];

        const list = Object.values(customers).map(c => {
            let liveStatus = 'offline';
            if (c.status === 'suspended' || c.profile === 'Expired_Profile') {
                liveStatus = 'suspended';
            } else if (c.status === 'terminated') {
                liveStatus = 'terminated';
            } else if (c.expireDate && c.expireDate < today) {
                liveStatus = 'expired';
            } else if (activeMap[c.username]) {
                liveStatus = 'active';
            }
            return {
                ...c,
                liveStatus,
                uptime: activeMap[c.username] ? activeMap[c.username].uptime : 'Offline',
                ipAddress: activeMap[c.username] ? activeMap[c.username].address : (c.ipAddress || 'N/A')
            };
        });

        res.json({ success: true, customers: list });
    } catch (e) {
        console.error('[CUSTOMERS ROUTE ERROR]:', e);
        res.status(500).json({ success: false, error: e.message, customers: [] });
    }
});
