// www/js/modules/rearing.js
// إدارة الفقس، عنابر التربية، اليوميات (علف/نافق)، دليل العامل الذكي، والمزامنة الكاملة مع الـ CRM

import { db, ref, push, update, atomicAdjust, syncBatchToCRM, crmDb, doc, getDoc } from '../config/firebase.js';
import {
    state, getBirdStandard, calcCrmExpectedPairs, fmtNum, toLocalInput, todayISO, round2
} from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, escapeHtml } from '../core/validators.js';
import { consumeFeedFromStock, recordBatchCost } from '../core/accounting.js';
import { clearShelvesForBatch, buildIncubatorCrmPayload } from './incubator.js';

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
    document.getElementById('hNewBatchName').value = `تربية ${slaughterDateObj.getDate()}/${slaughterDateObj.getMonth() + 1}`;

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
    document.getElementById('hNewBatchName').value = `تربية ${slDate.getDate()}/${slDate.getMonth() + 1}`;
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

        const finalName = customName || `تربية ${slaughterDateObj.getDate()}/${slaughterDateObj.getMonth() + 1}`;
        const hatchRate = initialEggs > 0 ? Number(((healthy / initialEggs) * 100).toFixed(1)) : 0;
        const expectedPairs = calcCrmExpectedPairs(healthy);
        const isQuailBatch = (b.birdType || 'quail') === 'quail';
        const safeMinAge = isQuailBatch ? Math.max(38, slAge) : slAge;
        const safeMaxAge = isQuailBatch ? Math.max(safeMinAge + 7, 45) : (slAge + Number(state.settings.crmExtraBufferDays ?? 5));
        const safeDeliveryStartISO = new Date(hatchDateObj.getTime() + safeMinAge * 86400000).toISOString().split('T')[0];
        const safeDeliveryEndISO = new Date(hatchDateObj.getTime() + safeMaxAge * 86400000).toISOString().split('T')[0];

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

        await clearShelvesForBatch(id);

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

        let crmMsg = ` وترحيل (${healthy}/${initialEggs} | فقس ${hatchRate}%) للـ CRM`;
        try {
            const targetTrack = (b.birdType === 'chicken' || b.birdType === 'turkey') ? 'weight' : 'quail';
            await syncBatchToCRM(id, {
                name: finalName,
                batchType: targetTrack,
                stage: 'rearing',
                birdType: b.birdType || 'quail',
                initialEggs,
                hatchedChicks: healthy,
                hatchRate,
                unfertilized: unfert,
                deadInShell: dead,
                aliveBirds: healthy,
                expectedChicks: healthy,
                expectedPairs,
                hatchDate: hatchDateObj.getTime(),
                slaughterAgeMin: safeMinAge,
                slaughterAgeMax: safeMaxAge,
                slaughterAge: safeMaxAge,
                deliveryStart: safeDeliveryStartISO,
                deliveryEnd: safeDeliveryEndISO,
                isOpen: false,
                isVisible: false,
                pendingApproval: true,
                fromFarm: true,
                farmSyncedAt: Date.now()
            }, false);
        } catch (err) {
            console.error('CRM Sync Error:', err);
            crmMsg = ' (تعذر الترحيل للـ CRM - يمكنك المزامنة لاحقاً)';
        }

        closeModal('modalHatch');
        showToast(`تم نقل "${finalName}" للتربية${crmMsg} 🚀`);
    }, 'جاري إتمام الفقس وتحديث الـ CRM...');
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

        if (feed > 0) {
            await consumeFeedFromStock({
                qtyKg: feed,
                batchId: id,
                desc: `علف يومي (${feed} كجم) - ${b.name}`
            });
        }

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

        if (dead > 0) {
            const newAlive = Math.max(0, aliveBirds - dead);
            const newExpectedPairs = calcCrmExpectedPairs(newAlive);
            await update(ref(db, `batches/${id}`), { crmExpectedPairs: newExpectedPairs });
            try {
                await syncBatchToCRM(id, {
                    aliveBirds: newAlive,
                    expectedPairs: newExpectedPairs
                }, false);
            } catch (err) {
                console.warn('CRM live expectedPairs update skipped:', err);
            }
        }

        closeModal('modalDaily');
        showToast('تم تسجيل اليومية وتحديث المخزون والـ CRM بنجاح ✅');
    }, 'جاري حفظ اليومية...');
}

/**
 * مزامنة آمنة وشاملة لكل الدفعات النشطة (المفرخ "عمر يوم" + عنابر التربية) مع الـ CRM دون مسح حجوزات العملاء!
 */
export async function syncLegacyBatchesToCRM() {
    const activeEntries = Object.entries(state.batches).filter(([, b]) =>
        b.status === 'incubator' || b.status === 'hatcher' || b.status === 'rearing'
    );
    if (activeEntries.length === 0) {
        return showToast('لا توجد دفعات نشطة في المفرخ أو التربية لمزامنتها', true);
    }

    const incCount = activeEntries.filter(([, b]) => b.status === 'incubator' || b.status === 'hatcher').length;
    const rearCount = activeEntries.filter(([, b]) => b.status === 'rearing').length;

    if (!confirm(`تم العثور على (${incCount}) دفعة عمر يوم بالمفرخ + (${rearCount}) دفعة بالتربية.\nسيتم مزامنتها كلها مع الـ CRM مع حفظ عدد البيض والفقس بدون التأثير على حجوزات العملاء.\nهل تريد المتابعة؟`)) {
        return;
    }

    await withActionLock('syncCRM', async () => {
        const batchDocRef = doc(crmDb, 'inventory', 'batches');
        const snap = await getDoc(batchDocRef);
        const existingCRM = snap.exists() ? snap.data() : {};
        const bufferDays = Number(state.settings.crmExtraBufferDays ?? 5);

        let createdCount = 0;
        let updatedCount = 0;

        for (const [id, b] of activeEntries) {
            const existsInCRM = Boolean(existingCRM[id]);

            if (b.status === 'incubator' || b.status === 'hatcher') {
                await syncBatchToCRM(id, buildIncubatorCrmPayload(b, !existsInCRM), !existsInCRM);
            } else {
                const initialEggs = Number(b.initialEggs) || 0;
                const hatched = Number(b.hatchedChicks) || 0;
                const alive = Math.max(0, hatched - (Number(b.totalDead) || 0));
                const expectedPairs = calcCrmExpectedPairs(alive);
                const hatchDateObj = b.hatchDate ? new Date(b.hatchDate) : new Date();
                const slAge = b.slaughterAge || getBirdStandard(b.birdType || 'quail').slaughter;
                const hatchRate = b.hatchRate ?? (initialEggs > 0 ? Number(((hatched / initialEggs) * 100).toFixed(1)) : 0);
                const targetTrack = (b.birdType === 'chicken' || b.birdType === 'turkey') ? 'weight' : 'quail';
                const isQuailBatch = (b.birdType || 'quail') === 'quail';
                const safeMinAge = isQuailBatch ? Math.max(38, slAge) : slAge;
                const safeMaxAge = isQuailBatch ? Math.max(safeMinAge + 7, 45) : (slAge + bufferDays);
                const safeDeliveryStartISO = new Date(hatchDateObj.getTime() + safeMinAge * 86400000).toISOString().split('T')[0];
                const safeDeliveryEndISO = new Date(hatchDateObj.getTime() + safeMaxAge * 86400000).toISOString().split('T')[0];

                const rearPayload = {
                    name: b.name,
                    batchType: targetTrack,
                    stage: 'rearing',
                    birdType: b.birdType || 'quail',
                    initialEggs,
                    hatchedChicks: hatched,
                    hatchRate,
                    unfertilized: Number(b.unfertilized) || 0,
                    deadInShell: Number(b.deadInShell) || 0,
                    aliveBirds: alive,
                    expectedChicks: hatched,
                    expectedPairs,
                    hatchDate: hatchDateObj.getTime(),
                    slaughterAgeMin: safeMinAge,
                    slaughterAgeMax: safeMaxAge,
                    slaughterAge: safeMaxAge,
                    fromFarm: true,
                    farmSyncedAt: Date.now()
                };

                if (!existsInCRM) {
                    rearPayload.deliveryStart = safeDeliveryStartISO;
                    rearPayload.deliveryEnd = safeDeliveryEndISO;
                    rearPayload.isOpen = false;
                    rearPayload.isVisible = false;
                    rearPayload.pendingApproval = true;
                }

                await syncBatchToCRM(id, rearPayload, !existsInCRM);
            }

            if (existsInCRM) updatedCount++;
            else createdCount++;
        }

        showToast(`✅ تمت المزامنة الكاملة: ${createdCount} جديدة + ${updatedCount} محدثة بأمان!`);
    }, 'جاري المزامنة الشاملة مع الـ CRM...');
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
