// www/js/modules/rearing.js
// إدارة الفقس، عنابر التربية، اليوميات (علف/نافق)، دليل العامل الذكي، والمزامنة اللحظية مع الـ CRM

import { db, ref, push, update, atomicAdjust, syncBatchToCRM, crmDb, doc, getDoc } from '../config/firebase.js';
import {
    state, getBirdStandard, calcCrmExpectedPairs, fmtNum, toLocalInput, todayISO, round2
} from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, escapeHtml } from '../core/validators.js';
import { consumeFeedFromStock, recordBatchCost } from '../core/accounting.js';
import { clearShelvesForBatch } from './incubator.js';

export function promptHatch(id) {
    const b = state.batches[id];
    if (!b) return;

    const std = getBirdStandard(b.birdType || 'quail');
    const hatchDateObj = b.hatchDate ? new Date(b.hatchDate) : new Date();
    const slAge = b.slaughterAge || std.slaughter;
    const slaughterDateObj = new Date(hatchDateObj.getTime() + slAge * 86400000);

    document.getElementById('hatchBatchId').value = id;
    document.getElementById('hatchInitialEggsHint').textContent = fmtNum(b.initialEggs || 0);
    document.getElementById('hHealthy').value = '';
    document.getElementById('hUnfert').value = '0';
    document.getElementById('hDead').value = '0';
    document.getElementById('hRearingSystem').value = 'floor';
    document.getElementById('hRearingDate').value = toLocalInput(hatchDateObj);
    document.getElementById('hSlaughterAge').value = slAge;
    document.getElementById('hExpectedSlaughterDate').value = toLocalInput(slaughterDateObj);
    document.getElementById('hNewBatchName').value = `دفعة ${slaughterDateObj.getDate()}/${slaughterDateObj.getMonth() + 1}`;

    openModal('modalHatch');
}

export function syncHatchSlaughterDate() {
    const rearingDateVal = document.getElementById('hRearingDate')?.value;
    const slAge = parseInt(document.getElementById('hSlaughterAge')?.value, 10) || 0;
    if (!rearingDateVal || slAge <= 0) return;

    const d = new Date(rearingDateVal);
    if (isNaN(d.getTime())) return;
    const slDate = new Date(d.getTime() + slAge * 86400000);
    document.getElementById('hExpectedSlaughterDate').value = toLocalInput(slDate);
    document.getElementById('hNewBatchName').value = `دفعة ${slDate.getDate()}/${slDate.getMonth() + 1}`;
}

export async function moveToRearing() {
    await withActionLock('moveToRearing', async () => {
        const id = document.getElementById('hatchBatchId')?.value;
        const b = state.batches[id];
        if (!b) return;

        const healthy = parsePositiveNumber(document.getElementById('hHealthy')?.value, 'الكتاكيت السليمة', { isInt: true });
        const unfert = parsePositiveNumber(document.getElementById('hUnfert')?.value || '0', 'غير المخصب', { allowZero: true, isInt: true });
        const dead = parsePositiveNumber(document.getElementById('hDead')?.value || '0', 'الكبس/الميت', { allowZero: true, isInt: true });
        const slAge = parsePositiveNumber(document.getElementById('hSlaughterAge')?.value, 'عمر الذبح', { isInt: true });

        if (healthy === null || unfert === null || dead === null || slAge === null) return;

        const initialEggs = Number(b.initialEggs) || 0;
        if (healthy + unfert + dead > initialEggs) {
            return showToast(`❌ مجموع المخرجات (${healthy + unfert + dead}) أكبر من البيض المدخل (${initialEggs})!`, true);
        }

        const rearingSys = document.getElementById('hRearingSystem')?.value || 'floor';
        const rearingDateStr = document.getElementById('hRearingDate')?.value;
        const slaughterDateStr = document.getElementById('hExpectedSlaughterDate')?.value;
        const customName = (document.getElementById('hNewBatchName')?.value || '').trim();

        const hatchDateObj = rearingDateStr ? new Date(rearingDateStr) : new Date(b.hatchDate || Date.now());
        const slaughterDateObj = slaughterDateStr
            ? new Date(slaughterDateStr)
            : new Date(hatchDateObj.getTime() + slAge * 86400000);

        const finalName = customName || `دفعة ${slaughterDateObj.getDate()}/${slaughterDateObj.getMonth() + 1}`;
        const hatchRate = initialEggs > 0 ? Number(((healthy / initialEggs) * 100).toFixed(1)) : 0;
        const expectedPairs = calcCrmExpectedPairs(healthy);
        const bufferDays = Number(state.settings.crmExtraBufferDays ?? 5);

        // 1. تحديث الدفعة في قاعدة بيانات المزرعة
        await update(ref(db, `batches/${id}`), {
            name: finalName,
            hatchDate: hatchDateObj.toISOString(),
            rearDate: slaughterDateObj.toISOString(),
            slaughterAge: slAge,
            status: 'rearing',
            hatchedChicks: healthy,
            hatchRate,
            rearingSystem: rearingSys,
            unfertilized: unfert,
            deadInShell: dead,
            crmExpectedPairs: expectedPairs
        });

        // 2. تفريغ أي أرفف مرتبطة بها في خريطة المكنة
        await clearShelvesForBatch(id);

        // 3. تسجيل تكلفة الكتاكيت داخلياً لحساب ربحية الدفعة (لا تلمس الخزنة أو مصروفات الشهر!)
        let chickUnitPrice = Number(state.settings.quailChick) || 3.5;
        if (b.birdType === 'chicken') chickUnitPrice = Number(state.settings.chickenChick) || 25;
        else if (b.birdType === 'turkey') chickUnitPrice = Number(state.settings.turkeyChick) || 60;

        if (chickUnitPrice > 0 && healthy > 0) {
            await recordBatchCost({
                amount: round2(healthy * chickUnitPrice),
                desc: `تكلفة كتاكيت محولة للتربية (${healthy} × ${chickUnitPrice} ج)`,
                batchId: id,
                costSource: 'chicks',
                chicksQty: healthy,
                unitCost: chickUnitPrice
            });
        }

        // 4. ترحيل للـ CRM (Firestore) مع حماية تامة
        let crmMsg = ' وترحيلها للـ CRM';
        try {
            await syncBatchToCRM(id, {
                name: finalName,
                expectedPairs,
                hatchDate: hatchDateObj.getTime(),
                slaughterAge: slAge + bufferDays
            }, true);
        } catch (err) {
            console.error('CRM Sync Error:', err);
            crmMsg = ' (تعذر الترحيل للـ CRM - يمكنك المزامنة لاحقاً)';
        }

        closeModal('modalHatch');
        showToast(`تم نقل "${finalName}" للتربية${crmMsg} 🚀`);
    }, 'جاري إتمام الفقس والترحيل...');
}

export function openDailyRearingModal(preselectedBatchId = null) {
    const sel = document.getElementById('dBatch');
    if (sel && preselectedBatchId) sel.value = preselectedBatchId;
    const deadEl = document.getElementById('dDead');
    const feedEl = document.getElementById('dFeed');
    if (deadEl) deadEl.value = '0';
    if (feedEl) feedEl.value = '0';
    openModal('modalDaily');
}

export async function saveDailyLog() {
    await withActionLock('rearingDaily', async () => {
        const id = document.getElementById('dBatch')?.value;
        const dead = parsePositiveNumber(document.getElementById('dDead')?.value || '0', 'النافق', { allowZero: true, isInt: true });
        const feed = parsePositiveNumber(document.getElementById('dFeed')?.value || '0', 'العلف المستهلك', { allowZero: true });

        if (!id) return showToast('برجاء اختيار دفعة التربية', true);
        if (dead === null || feed === null) return;
        if (dead === 0 && feed === 0) return showToast('أدخل النافق أو العلف أولاً', true);

        const b = state.batches[id];
        if (!b) return;
        const aliveBirds = (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0);
        if (dead > aliveBirds) {
            return showToast(`❌ خطأ: المتبقي بالعنبر ${aliveBirds} طائر وأنت تحاول تسجيل ${dead} نافق!`, true);
        }

        // 1. سحب العلف ذرياً بمتوسط السعر المرجّح وتسجيله كتكلفة على الدفعة (دون المساس بمصروفات الشهر النقدية)
        if (feed > 0) {
            await consumeFeedFromStock({
                qtyKg: feed,
                batchId: id,
                desc: `علف يومي (${feed} كجم) - ${b.name}`
            });
        }

        // 2. تسجيل اليومية في تاريخ الدفعة وتحديث إجمالياتها ذرياً
        await push(ref(db, `batches/${id}/dailyLogs`), {
            date: todayISO(),
            dead,
            feed,
            timestamp: Date.now()
        });

        if (dead > 0) {
            await atomicAdjust(`batches/${id}/totalDead`, dead, { allowNegative: false, decimals: 0 });
        }
        if (feed > 0) {
            await atomicAdjust(`batches/${id}/totalFeed`, feed, { allowNegative: false, decimals: 2 });
        }

        // 3. عند تسجيل نافق، تحديث الأجواز المتوقعة في الـ CRM لحظياً دون لمس الحجوزات!
        if (dead > 0) {
            const newAlive = Math.max(0, aliveBirds - dead);
            const newExpectedPairs = calcCrmExpectedPairs(newAlive);
            await update(ref(db, `batches/${id}`), { crmExpectedPairs: newExpectedPairs });
            try {
                await syncBatchToCRM(id, { expectedPairs: newExpectedPairs }, false);
            } catch (err) {
                console.warn('CRM live expectedPairs update skipped:', err);
            }
        }

        closeModal('modalDaily');
        showToast('تم تسجيل اليومية وتحديث المخزون والـ CRM بنجاح ✅');
    }, 'جاري حفظ اليومية...');
}

/**
 * مزامنة آمنة لجميع دفعات التربية النشطة مع الـ CRM (تُنشئ الجديد وتُحدّث الموجود دون مسح الحجوزات!)
 */
export async function syncLegacyBatchesToCRM() {
    const rearingEntries = Object.entries(state.batches).filter(([, b]) => b.status === 'rearing');
    if (rearingEntries.length === 0) {
        return showToast('لا توجد دفعات نشطة في التربية لمزامنتها', true);
    }
    if (!confirm(`تم العثور على (${rearingEntries.length}) دفعة في التربية.
سيتم مزامنة المتاح المتوقع مع الـ CRM بدون التأثير على حجوزات العملاء.
هل تريد المتابعة؟`)) {
        return;
    }

    await withActionLock('syncCRM', async () => {
        const batchDocRef = doc(crmDb, 'inventory', 'batches');
        const snap = await getDoc(batchDocRef);
        const existingCRM = snap.exists() ? snap.data() : {};
        const bufferDays = Number(state.settings.crmExtraBufferDays ?? 5);

        let createdCount = 0;
        let updatedCount = 0;

        for (const [id, b] of rearingEntries) {
            const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));
            const expectedPairs = calcCrmExpectedPairs(alive);
            const hatchDateObj = b.hatchDate ? new Date(b.hatchDate) : new Date();
            const slAge = b.slaughterAge || getBirdStandard(b.birdType || 'quail').slaughter;
            const existsInCRM = Boolean(existingCRM[id]);

            await syncBatchToCRM(id, {
                name: b.name,
                expectedPairs,
                hatchDate: hatchDateObj.getTime(),
                slaughterAge: slAge + bufferDays
            }, !existsInCRM);

            if (existsInCRM) updatedCount++;
            else createdCount++;
        }

        showToast(`✅ تمت المزامنة: ${createdCount} جديدة + ${updatedCount} محدثة بأمان!`);
    }, 'جاري المزامنة الآمنة مع الـ CRM...');
}

// ================= دليل العامل اليومي الذكي =================
function getQuailDailyNeeds(age, aliveCount, system) {
    let temp = 35, feedPerBirdG = 5, meds = 'ماء نقي بدون إضافات';
    if (age <= 3) { temp = 37; feedPerBirdG = 4; meds = 'مضاد حيوي معوي/تنفسي + فيتامين AD3E'; }
    else if (age <= 7) { temp = 35; feedPerBirdG = 6; meds = 'أملاح معدنية وأحماض أمينية'; }
    else if (age <= 10) { temp = 33; feedPerBirdG = 8; if (age === 10) meds = 'تحصين نيوكاسل (شرب أو تغطيس)'; }
    else if (age <= 14) { temp = 31; feedPerBirdG = 11; if (age >= 13) meds = 'جرعة وقاية: كوكسيديا وكلوستريديا'; }
    else if (age <= 21) { temp = 28; feedPerBirdG = 15; meds = 'فيتامين هـ سيلينيوم لرفع المناعة'; }
    else if (age <= 28) { temp = 25; feedPerBirdG = 20; meds = 'ماء نقي + رفع كفاءة التهوية'; }
    else if (age <= 34) { temp = 24; feedPerBirdG = 24; meds = 'ماء نقي (فترة سحب الدواء)'; }
    else { temp = 24; feedPerBirdG = 28; meds = 'ماء نقي — القطيع جاهز للذبح'; }

    const dailyFeedKg = (feedPerBirdG * aliveCount) / 1000;
    const dailyWaterL = dailyFeedKg * 2.2;
    const spaceSqm = system === 'battery' ? (aliveCount / 120) : (aliveCount / 60);

    // حساب الاستهلاك التراكمي المعياري حتى هذا العمر للمقارنة مع الفعلي
    let cumGramsPerBird = 0;
    for (let d = 1; d <= age; d++) {
        if (d <= 3) cumGramsPerBird += 4;
        else if (d <= 7) cumGramsPerBird += 6;
        else if (d <= 10) cumGramsPerBird += 8;
        else if (d <= 14) cumGramsPerBird += 11;
        else if (d <= 21) cumGramsPerBird += 15;
        else if (d <= 28) cumGramsPerBird += 20;
        else if (d <= 34) cumGramsPerBird += 24;
        else cumGramsPerBird += 28;
    }
    const targetCumFeedKg = (cumGramsPerBird * aliveCount) / 1000;

    return {
        temp,
        feed: dailyFeedKg.toFixed(2),
        water: dailyWaterL.toFixed(1),
        space: spaceSqm.toFixed(1),
        meds,
        targetCumFeedKg: targetCumFeedKg.toFixed(1)
    };
}

export function openDailyGuide(id) {
    const b = state.batches[id];
    if (!b) return;
    if ((b.birdType || 'quail') !== 'quail') {
        return showToast('دليل الرعاية اليومي مخصص حالياً للسمان فقط', true);
    }

    const age = b.hatchDate ? Math.max(1, Math.floor((Date.now() - new Date(b.hatchDate).getTime()) / 86400000)) : 1;
    const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));
    const system = b.rearingSystem || 'floor';
    const needs = getQuailDailyNeeds(age, alive, system);
    const actualFeed = Number(b.totalFeed) || 0;
    const targetCum = Number(needs.targetCumFeedKg);
    const diffPct = targetCum > 0 ? Math.round(((actualFeed - targetCum) / targetCum) * 100) : 0;

    let feedComparison = '';
    if (actualFeed === 0) {
        feedComparison = '<span class="sub-text">لم يُسجَّل سحب علف بعد لهذه الدفعة.</span>';
    } else if (diffPct > 15) {
        feedComparison = `<span class="text-danger">⚠️ الاستهلاك الفعلي (${actualFeed} كجم) أعلى من المعيار (${targetCum} كجم) بـ ${diffPct}% — راجع هدر العلافات!</span>`;
    } else if (diffPct < -15) {
        feedComparison = `<span class="text-warning">⚠️ الاستهلاك الفعلي (${actualFeed} كجم) أقل من المعيار (${targetCum} كجم) — تأكد من صحة القطيع والحرارة.</span>`;
    } else {
        feedComparison = `<span class="text-success">✅ الاستهلاك الفعلي (${actualFeed} كجم) مطابق للمعيار (${targetCum} كجم).</span>`;
    }

    const el = document.getElementById('dailyGuideContent');
    if (el) {
        el.innerHTML = `
            <div class="info-box" style="text-align:center; margin-bottom:12px;">
                <span class="sub-text">دفعة: <strong>${escapeHtml(b.name)}</strong></span>
                <div style="font-size:22px; font-weight:800; color:var(--primary);">عمر ${age} يوم (${fmtNum(alive)} طائر)</div>
            </div>
            <div class="grid-2">
                <div class="guide-tile border-danger">
                    <span class="sub-text">🌡️ الحرارة المطلوبة</span>
                    <strong>${needs.temp} °C</strong>
                </div>
                <div class="guide-tile border-info">
                    <span class="sub-text">💧 المياه لليوم</span>
                    <strong>${needs.water} لتر</strong>
                </div>
                <div class="guide-tile border-warning">
                    <span class="sub-text">🌾 العلف اليومي</span>
                    <strong>${needs.feed} كجم</strong>
                </div>
                <div class="guide-tile border-success">
                    <span class="sub-text">📏 المساحة (${system === 'floor' ? 'أرضي' : 'بطاريات'})</span>
                    <strong>${needs.space} م²</strong>
                </div>
            </div>
            <div class="guide-tile border-primary" style="margin-top:10px;">
                <span class="sub-text">💊 التحصينات / الإضافات اليوم</span>
                <strong>${needs.meds}</strong>
            </div>
            <div class="info-box" style="margin-top:10px; font-size:13px;">
                <strong>📊 مؤشر الانضباط الغذائي:</strong><br>${feedComparison}
            </div>
        `;
    }
    openModal('modalDailyGuide');
}
