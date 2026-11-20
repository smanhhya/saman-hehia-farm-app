// www/js/modules/settings.js
// مركز التحكم الشامل: الإعدادات، تسعير البيض والكتاكيت، إعدادات المكنة والـ CRM، والنسخ الاحتياطي JSON

import { db, ref, set, get, remove } from '../config/firebase.js';
import { state, DEFAULT_SETTINGS, fmtNum, todayISO } from '../core/state.js';
import { showToast, withActionLock } from '../core/ui.js';
import { parsePositiveNumber } from '../core/validators.js';

export function switchSettingsTab(tabId, element) {
    document.querySelectorAll('.settings-nav-item').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.settings-tab').forEach((el) => el.classList.remove('active'));
    if (element) element.classList.add('active');
    const tab = document.getElementById(`tab-${tabId}`);
    if (tab) tab.classList.add('active');
}

export function filterSettingsSearch(query) {
    const q = (query || '').trim().toLowerCase();
    const tabs = document.querySelectorAll('.settings-tab');
    const cards = document.querySelectorAll('.settings-card');

    if (!q) {
        cards.forEach((c) => (c.style.display = ''));
        tabs.forEach((t) => {
            t.style.display = '';
        });
        return;
    }

    tabs.forEach((t) => {
        let hasMatch = false;
        t.querySelectorAll('.settings-card').forEach((card) => {
            const match = card.textContent.toLowerCase().includes(q);
            card.style.display = match ? '' : 'none';
            if (match) hasMatch = true;
        });
        t.style.display = hasMatch ? 'block' : 'none';
    });
}

export function hydrateSettingsUI() {
    const s = state.settings;
    const setVal = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = v;
    };

    setVal('setFarmName', s.farmName || DEFAULT_SETTINGS.farmName);
    setVal('setBirdType', s.birdType || 'quail');
    setVal('setFeed', s.feedPrice ?? 30);
    setVal('setLowFeedThreshold', s.lowFeedThresholdKg ?? 50);

    setVal('setQuailEgg', s.quailEgg ?? 1.5);
    setVal('setChickenEgg', s.chickenEgg ?? 10);
    setVal('setTurkeyEgg', s.turkeyEgg ?? 25);

    setVal('setQuailChick', s.quailChick ?? 3.5);
    setVal('setChickenChick', s.chickenChick ?? 25);
    setVal('setTurkeyChick', s.turkeyChick ?? 60);

    setVal('setIncShelves', s.setIncShelves ?? 12);
    setVal('setIncShelfCapacity', s.setIncShelfCapacity ?? 500);
    setVal('setQuailHatcherDays', s.quailHatcherDays ?? 14);
    setVal('setQuailHatchDays', s.quailHatchDays ?? 17);
    setVal('setQuailSlaughterDays', s.quailSlaughterDays ?? 38);

    setVal('setCrmSafetyMargin', s.crmSafetyMarginPct ?? 8);
    setVal('setCrmExtraDays', s.crmExtraBufferDays ?? 5);

    // تحديث اسم المزرعة في الشريط الجانبي والعنوان
    const brandName = s.farmName || DEFAULT_SETTINGS.farmName;
    document.querySelectorAll('.farm-brand-text').forEach((el) => {
        el.textContent = brandName;
    });

    calcIncubatorTotalCap();
}

export function calcIncubatorTotalCap() {
    const shelves = parseInt(document.getElementById('setIncShelves')?.value, 10) || 0;
    const cap = parseInt(document.getElementById('setIncShelfCapacity')?.value, 10) || 0;
    const disp = document.getElementById('incTotalCapacityDisplay');
    if (disp) disp.textContent = fmtNum(shelves * cap);
}

export async function saveSettings() {
    await withActionLock('saveSettings', async () => {
        const feedPrice = parsePositiveNumber(document.getElementById('setFeed')?.value, 'سعر العلف', { allowZero: true });
        const shelves = parsePositiveNumber(document.getElementById('setIncShelves')?.value, 'عدد أرفف المكنة', { isInt: true });
        const shelfCap = parsePositiveNumber(document.getElementById('setIncShelfCapacity')?.value, 'سعة الرف', { isInt: true });

        if (feedPrice === null || shelves === null || shelfCap === null) return;

        const newSettings = {
            ...state.settings,
            farmName: (document.getElementById('setFarmName')?.value || '').trim() || DEFAULT_SETTINGS.farmName,
            birdType: document.getElementById('setBirdType')?.value || 'quail',
            feedPrice,
            lowFeedThresholdKg: parseFloat(document.getElementById('setLowFeedThreshold')?.value) || 50,
            quailEgg: parseFloat(document.getElementById('setQuailEgg')?.value) || 1.5,
            chickenEgg: parseFloat(document.getElementById('setChickenEgg')?.value) || 10,
            turkeyEgg: parseFloat(document.getElementById('setTurkeyEgg')?.value) || 25,
            quailChick: parseFloat(document.getElementById('setQuailChick')?.value) || 3.5,
            chickenChick: parseFloat(document.getElementById('setChickenChick')?.value) || 25,
            turkeyChick: parseFloat(document.getElementById('setTurkeyChick')?.value) || 60,
            setIncShelves: shelves,
            setIncShelfCapacity: shelfCap,
            quailHatcherDays: parseInt(document.getElementById('setQuailHatcherDays')?.value, 10) || 14,
            quailHatchDays: parseInt(document.getElementById('setQuailHatchDays')?.value, 10) || 17,
            quailSlaughterDays: parseInt(document.getElementById('setQuailSlaughterDays')?.value, 10) || 38,
            crmSafetyMarginPct: Math.min(50, Math.max(0, parseFloat(document.getElementById('setCrmSafetyMargin')?.value) || 8)),
            crmExtraBufferDays: Math.max(0, parseInt(document.getElementById('setCrmExtraDays')?.value, 10) || 5)
        };

        await set(ref(db, 'settings'), newSettings);
        showToast('تم حفظ جميع إعدادات التشغيل والمكنة بنجاح 💾');
    }, 'جاري حفظ الإعدادات...');
}

// ================= النسخ الاحتياطي والاستعادة (JSON) =================
export async function exportFullBackup() {
    await withActionLock('exportBackup', async () => {
        const snap = await get(ref(db, '/'));
        const data = snap.exists() ? snap.val() : {};
        const payload = {
            exportedAt: new Date().toISOString(),
            appVersion: '2.0.0',
            projectId: 'sman-6512c',
            data
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `saman-hehia-backup-${todayISO()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('تم تحميل النسخة الاحتياطية الكاملة بنجاح 📥');
    }, 'جاري تجهيز النسخة الاحتياطية...');
}

export function triggerImportBackup() {
    const input = document.getElementById('backupFileInput');
    if (input) {
        input.value = '';
        input.click();
    }
}

export async function handleImportBackup(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;

    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const dataToRestore = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;

        if (!dataToRestore || typeof dataToRestore !== 'object') {
            return showToast('ملف النسخة الاحتياطية غير صالح!', true);
        }

        const ok = confirm('⚠️ تنبيه: استعادة النسخة الاحتياطية ستستبدل البيانات الحالية في قاعدة البيانات.
هل أنت متأكد من المتابعة؟');
        if (!ok) return;
        if (prompt('اكتب "استعادة" للتأكيد النهائي:') !== 'استعادة') return;

        await withActionLock('importBackup', async () => {
            await set(ref(db, '/'), dataToRestore);
            showToast('تمت استعادة البيانات بنجاح ✅');
        }, 'جاري استعادة البيانات...');
    } catch (err) {
        console.error(err);
        showToast('فشل قراءة ملف JSON — تأكد من سلامة الملف', true);
    }
}

export async function resetSystem() {
    if (!confirm('🛑 تحذير شديد: سيتم مسح جميع الدفعات والمخازن والخزنة للأبد!
ننصح بشدة بتحميل نسخة احتياطية أولاً.')) return;
    if (prompt('اكتب "تأكيد" للمسح الكامل:') !== 'تأكيد') return;

    await withActionLock('factoryReset', async () => {
        await remove(ref(db, 'batches'));
        await remove(ref(db, 'archivedBatches'));
        await remove(ref(db, 'incubatorGrid'));
        await remove(ref(db, 'ledger'));
        await remove(ref(db, 'archivedLedger'));
        await remove(ref(db, 'monthlyClosings'));
        await remove(ref(db, 'financialCenter'));
        await remove(ref(db, 'inventory'));
        await remove(ref(db, 'cashBox'));
        await remove(ref(db, 'breedersLogs'));
        await remove(ref(db, 'breedersHistoryLogs'));
        showToast('تم تصفير بيانات النظام بنجاح');
    }, 'جاري تصفير النظام...');
}
