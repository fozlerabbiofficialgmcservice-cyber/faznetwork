<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>FAZ NETWORK - Admin ISP & Hotspot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    </style>
</head>
<body class="bg-slate-950 text-slate-100 font-sans pb-24 selection:bg-blue-600">

    <!-- Top App Bar -->
    <header class="bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-3 sticky top-0 z-40 flex items-center justify-between">
        <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
                <i class="fa-solid fa-server text-lg"></i>
            </div>
            <div>
                <h1 class="text-sm font-bold tracking-tight">FAZ NETWORK</h1>
                <div class="flex items-center gap-1.5">
                    <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span class="text-[11px] text-emerald-400 font-medium">Online Engine</span>
                </div>
            </div>
        </div>
        <button onclick="fetchAllData()" id="btn-refresh" class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 transition flex items-center justify-center text-slate-300 border border-slate-700/60">
            <i class="fa-solid fa-rotate text-xs"></i>
        </button>
    </header>

    <main class="p-4 space-y-4 max-w-3xl mx-auto">

        <!-- Mobile Metric Badges -->
        <div class="grid grid-cols-2 gap-2.5">
            <div class="bg-slate-900 border border-slate-800/80 p-3.5 rounded-2xl relative overflow-hidden">
                <div class="flex items-center justify-between">
                    <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">PPPoE ইউজার</span>
                    <i class="fa-solid fa-users text-blue-500 text-sm"></i>
                </div>
                <div class="text-2xl font-black mt-1 text-slate-100" id="stat-pppoe-count">0</div>
                <div class="text-[10px] text-slate-500 mt-0.5">সিক্রেট রেজিস্টার্ড</div>
            </div>

            <div class="bg-slate-900 border border-slate-800/80 p-3.5 rounded-2xl relative overflow-hidden">
                <div class="flex items-center justify-between">
                    <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">হটস্পট ইউজার</span>
                    <i class="fa-solid fa-wifi text-amber-500 text-sm"></i>
                </div>
                <div class="text-2xl font-black mt-1 text-slate-100" id="stat-hotspot-count">0</div>
                <div class="text-[10px] text-slate-500 mt-0.5">ইউজার ম্যানেজার</div>
            </div>

            <div class="bg-slate-900 border border-slate-800/80 p-3.5 rounded-2xl">
                <div class="flex items-center justify-between">
                    <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">মোট ট্রানজেকশন</span>
                    <i class="fa-solid fa-receipt text-indigo-400 text-sm"></i>
                </div>
                <div class="text-2xl font-black mt-1 text-slate-100" id="stat-trx-count">0</div>
                <div class="text-[10px] text-slate-500 mt-0.5">বিকাশ / নগদ</div>
            </div>

            <div class="bg-slate-900 border border-slate-800/80 p-3.5 rounded-2xl">
                <div class="flex items-center justify-between">
                    <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">মোট আদায়</span>
                    <i class="fa-solid fa-bangladeshi-taka-sign text-emerald-400 text-sm"></i>
                </div>
                <div class="text-2xl font-black mt-1 text-emerald-400" id="stat-total-amount">৳0</div>
                <div class="text-[10px] text-slate-500 mt-0.5">অটো রিচার্জ জমা</div>
            </div>
        </div>

        <!-- PPPoE Controls Section -->
        <section id="sec-pppoe" class="space-y-3">
            <div class="flex gap-2">
                <div class="relative flex-1">
                    <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3.5 text-slate-500 text-xs"></i>
                    <input type="text" id="search-pppoe" oninput="filterPppoe()" placeholder="PPPoE ইউজার বা ফোন নম্বর..." class="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-3 py-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500">
                </div>
                <button onclick="openModal('modal-pppoe')" class="bg-blue-600 hover:bg-blue-500 active:scale-95 text-white px-3.5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-blue-600/20">
                    <i class="fa-solid fa-user-plus text-xs"></i> <span>নতুন</span>
                </button>
            </div>

            <div id="pppoe-list" class="space-y-2.5">
                <div class="text-center py-10 text-xs text-slate-500">ডাটা লোড হচ্ছে...</div>
            </div>
        </section>

        <!-- Hotspot Section -->
        <section id="sec-hotspot" class="space-y-3 hidden">
            <div class="flex gap-2">
                <div class="relative flex-1">
                    <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3.5 text-slate-500 text-xs"></i>
                    <input type="text" id="search-hotspot" oninput="filterHotspot()" placeholder="হটস্পট ক্লায়েন্ট খুঁজুন..." class="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-3 py-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500">
                </div>
                <button onclick="fetchAllData()" class="bg-slate-800 text-slate-300 px-3.5 py-2.5 rounded-xl text-xs font-semibold border border-slate-700">
                    <i class="fa-solid fa-arrows-rotate"></i>
                </button>
            </div>

            <div id="hotspot-list" class="space-y-2.5">
                <div class="text-center py-10 text-xs text-slate-500">হটস্পট ডাটা লোড হচ্ছে...</div>
            </div>
        </section>

        <!-- Transactions Section -->
        <section id="sec-trx" class="space-y-3 hidden">
            <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 flex justify-between items-center text-xs text-slate-400">
                <span>সর্বশেষ পেমেন্ট ট্র্যাকিং</span>
                <span id="trx-badge-count" class="px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-bold text-[10px]">0 Trx</span>
            </div>
            <div id="trx-list" class="space-y-2.5">
                <div class="text-center py-10 text-xs text-slate-500">কোনো লেনদেন পাওয়া যায়নি</div>
            </div>
        </section>

    </main>

    <!-- Bottom Navigation Bar (Mobile Native Style) -->
    <nav class="fixed bottom-0 left-0 right-0 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 z-40 px-4 py-2 flex justify-around">
        <button onclick="navigateTab('pppoe')" id="nav-btn-pppoe" class="flex flex-col items-center gap-1 text-blue-500 py-1 flex-1">
            <i class="fa-solid fa-network-wired text-base"></i>
            <span class="text-[10px] font-bold">PPPoE</span>
        </button>
        <button onclick="navigateTab('hotspot')" id="nav-btn-hotspot" class="flex flex-col items-center gap-1 text-slate-400 py-1 flex-1">
            <i class="fa-solid fa-wifi text-base"></i>
            <span class="text-[10px] font-medium">Hotspot</span>
        </button>
        <button onclick="navigateTab('trx')" id="nav-btn-trx" class="flex flex-col items-center gap-1 text-slate-400 py-1 flex-1">
            <i class="fa-solid fa-clock-rotate-left text-base"></i>
            <span class="text-[10px] font-medium">পেমেন্টস</span>
        </button>
    </nav>

    <!-- Modal: Add PPPoE User -->
    <div id="modal-pppoe" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 hidden items-end sm:items-center justify-center p-0 sm:p-4">
        <div class="bg-slate-900 border border-slate-800 w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div class="flex justify-between items-center pb-2 border-b border-slate-800">
                <h3 class="text-sm font-bold text-slate-100 flex items-center gap-2">
                    <i class="fa-solid fa-user-plus text-blue-500"></i> নতুন PPPoE ক্লায়েন্ট
                </h3>
                <button onclick="closeModal('modal-pppoe')" class="w-8 h-8 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center">
                    <i class="fa-solid fa-xmark text-xs"></i>
                </button>
            </div>
            <div class="space-y-3 text-xs">
                <div>
                    <label class="block text-slate-400 mb-1">ইউজারনেম (Login ID)</label>
                    <input type="text" id="pppoe-name" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-slate-400 mb-1">পাসওয়ার্ড</label>
                    <input type="text" id="pppoe-pass" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 focus:outline-none focus:border-blue-500 font-mono">
                </div>
                <div>
                    <label class="block text-slate-400 mb-1">প্যাকেজ / প্রোফাইল</label>
                    <input type="text" id="pppoe-prof" placeholder="যেমন: 10Mbps / default" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 focus:outline-none focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-slate-400 mb-1">মোবাইল নম্বর / নোট</label>
                    <input type="text" id="pppoe-comm" placeholder="যেমন: 017xxxxxxxx" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 focus:outline-none focus:border-blue-500">
                </div>
            </div>
            <div class="pt-2 flex gap-2">
                <button onclick="closeModal('modal-pppoe')" class="w-1/2 py-3 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold">বাতিল</button>
                <button onclick="savePppoeUser()" class="w-1/2 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-lg shadow-blue-600/30">সংরক্ষণ করুন</button>
            </div>
        </div>
    </div>

    <script>
        let pppoeRawData = [];
        let hotspotRawData = [];

        function navigateTab(tab) {
            ['pppoe', 'hotspot', 'trx'].forEach(t => {
                document.getElementById(`sec-${t}`).classList.add('hidden');
                document.getElementById(`nav-btn-${t}`).className = 'flex flex-col items-center gap-1 text-slate-400 py-1 flex-1';
            });
            document.getElementById(`sec-${tab}`).classList.remove('hidden');
            document.getElementById(`nav-btn-${tab}`).className = 'flex flex-col items-center gap-1 text-blue-500 py-1 flex-1';
        }

        function openModal(id) {
            document.getElementById(id).classList.remove('hidden');
            document.getElementById(id).classList.add('flex');
        }

        function closeModal(id) {
            document.getElementById(id).classList.add('hidden');
            document.getElementById(id).classList.remove('flex');
        }

        async function fetchAllData() {
            const spinBtn = document.getElementById('btn-refresh');
            spinBtn.classList.add('animate-spin');

            try {
                // ১. PPPoE Secret লিস্ট ফেচ
                const pRes = await fetch('/api/admin/pppoe/list');
                pppoeRawData = await pRes.json();
                renderPppoeCards(pppoeRawData);

                // ২. Hotspot ইউজার ফেচ
                const hRes = await fetch('/api/admin/hotspot/list');
                hotspotRawData = await hRes.json();
                renderHotspotCards(hotspotRawData);

                // ৩. ট্রানজেকশন হিস্ট্রি ফেচ
                const tRes = await fetch('/api/admin/transactions');
                const tData = await tRes.json();
                renderTrxCards(tData);

            } catch (err) {
                console.error(err);
            } finally {
                spinBtn.classList.remove('animate-spin');
            }
        }

        function renderPppoeCards(list) {
            const container = document.getElementById('pppoe-list');
            document.getElementById('stat-pppoe-count').innerText = list.length || 0;

            if (!list.length) {
                container.innerHTML = '<div class="text-center py-8 text-xs text-slate-500">কোনো PPPoE ইউজার পাওয়া যায়নি</div>';
                return;
            }

            container.innerHTML = list.map(item => {
                const isDisabled = item.disabled === 'true';
                return `
                <div class="bg-slate-900 border border-slate-800/90 p-3.5 rounded-2xl flex flex-col gap-2.5">
                    <div class="flex items-start justify-between">
                        <div>
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-slate-100">${item.name}</span>
                                <span class="text-[10px] px-2 py-0.5 rounded-md font-semibold ${isDisabled ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}">
                                    ${isDisabled ? 'Disabled' : 'Active'}
                                </span>
                            </div>
                            <div class="text-[11px] text-slate-400 mt-1 flex items-center gap-2">
                                <span><i class="fa-solid fa-bolt text-amber-400 mr-1"></i>${item.profile || 'default'}</span>
                                <span><i class="fa-solid fa-key text-slate-500 mr-1"></i>${item.password || 'N/A'}</span>
                            </div>
                        </div>
                        <button onclick="togglePppoeStatus('${item.name}', '${isDisabled}')" class="px-3 py-1.5 rounded-xl text-xs font-semibold ${isDisabled ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-slate-800 hover:bg-rose-600/30 text-rose-400 border border-slate-700'}">
                            ${isDisabled ? 'Enable' : 'Disable'}
                        </button>
                    </div>
                    ${item.comment ? `<div class="bg-slate-950/70 p-2 rounded-xl text-[10px] text-slate-400 font-mono border border-slate-800/60 truncate"><i class="fa-regular fa-comment-dots mr-1"></i>${item.comment}</div>` : ''}
                </div>`;
            }).join('');
        }

        function filterPppoe() {
            const q = document.getElementById('search-pppoe').value.toLowerCase();
            const filtered = pppoeRawData.filter(i => 
                (i.name && i.name.toLowerCase().includes(q)) || 
                (i.comment && i.comment.toLowerCase().includes(q))
            );
            renderPppoeCards(filtered);
        }

        function renderHotspotCards(list) {
            const container = document.getElementById('hotspot-list');
            document.getElementById('stat-hotspot-count').innerText = list.length || 0;

            if (!list.length) {
                container.innerHTML = '<div class="text-center py-8 text-xs text-slate-500">কোনো হটস্পট ইউজার পাওয়া যায়নি</div>';
                return;
            }

            container.innerHTML = list.map(item => `
                <div class="bg-slate-900 border border-slate-800/90 p-3.5 rounded-2xl flex items-center justify-between">
                    <div>
                        <div class="font-bold text-sm text-amber-400 font-mono">${item.name}</div>
                        <div class="text-[11px] text-slate-400 mt-0.5">গ্রুপ: ${item.group || 'Hotspot'}</div>
                        ${item.comment ? `<div class="text-[10px] text-slate-500 mt-1 max-w-[200px] truncate">${item.comment}</div>` : ''}
                    </div>
                    <button onclick="renewHotspotUser('${item.name}')" class="bg-amber-600/20 border border-amber-500/30 text-amber-400 px-3 py-1.5 rounded-xl text-xs font-semibold active:scale-95">
                        রিনিউ
                    </button>
                </div>
            `).join('');
        }

        function filterHotspot() {
            const q = document.getElementById('search-hotspot').value.toLowerCase();
            const filtered = hotspotRawData.filter(i => 
                (i.name && i.name.toLowerCase().includes(q)) || 
                (i.comment && i.comment.toLowerCase().includes(q))
            );
            renderHotspotCards(filtered);
        }

        function renderTrxCards(store) {
            const container = document.getElementById('trx-list');
            const keys = Object.keys(store || {});
            document.getElementById('stat-trx-count').innerText = keys.length;
            document.getElementById('trx-badge-count').innerText = `${keys.length} Trx`;

            let total = 0;
            keys.forEach(k => total += parseFloat(store[k].amount || 0));
            document.getElementById('stat-total-amount').innerText = `৳${total}`;

            if (!keys.length) {
                container.innerHTML = '<div class="text-center py-8 text-xs text-slate-500">কোনো পেমেন্ট হিস্ট্রি নেই</div>';
                return;
            }

            container.innerHTML = keys.reverse().map(k => {
                const item = store[k];
                return `
                <div class="bg-slate-900 border border-slate-800/90 p-3.5 rounded-2xl flex justify-between items-center">
                    <div>
                        <div class="flex items-center gap-2">
                            <span class="font-mono font-bold text-xs text-blue-400">${k}</span>
                            <span class="text-[10px] px-2 py-0.5 rounded-full ${item.used ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}">
                                ${item.used ? 'সক্রিয়' : 'পেন্ডিং'}
                            </span>
                        </div>
                        <div class="text-[11px] text-slate-400 mt-1">নম্বর: ${item.phone || 'অজানা'}</div>
                        <div class="text-[10px] text-slate-500 mt-0.5">${item.receivedAt ? new Date(item.receivedAt).toLocaleTimeString('en-GB') : ''}</div>
                    </div>
                    <div class="text-right">
                        <div class="text-base font-black text-emerald-400">৳${item.amount}</div>
                    </div>
                </div>`;
            }).join('');
        }

        async function savePppoeUser() {
            const name = document.getElementById('pppoe-name').value.trim();
            const password = document.getElementById('pppoe-pass').value.trim();
            const profile = document.getElementById('pppoe-prof').value.trim();
            const comment = document.getElementById('pppoe-comm').value.trim();

            if (!name || !password) return alert('ইউজারনেম ও পাসওয়ার্ড প্রয়োজন');

            const res = await fetch('/api/admin/pppoe/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, password, profile, comment })
            });
            const data = await res.json();
            if (data.success) {
                closeModal('modal-pppoe');
                fetchAllData();
            } else {
                alert('ব্যর্থ হয়েছে: ' + (data.error || 'সমস্যা হয়েছে'));
            }
        }

        async function togglePppoeStatus(username, currentDisabled) {
            const targetDisable = currentDisabled === 'true' ? 'no' : 'yes';
            await fetch('/api/admin/pppoe/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, disable: targetDisable })
            });
            fetchAllData();
        }

        async function renewHotspotUser(username) {
            const profile = prompt("কোন প্রোফাইল দিতে চান?", "Profile-30Day");
            if (!profile) return;
            await fetch('/api/admin/hotspot/renew', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, profile })
            });
            alert('সফলভাবে রিনিউ সম্পন্ন হয়েছে');
            fetchAllData();
        }

        // অটো ইনিশিয়ালাইজেশন
        fetchAllData();
    </script>
</body>
</html>
