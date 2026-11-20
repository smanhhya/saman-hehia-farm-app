// www/js/modules/breeders.js
// إدارة قطيع الأمهات، العمر الحقيقي، اليوميات، الاستبعاد، وفرز البيض (تفريخ / مائدة / كسر)

import { db, ref, set, push, atomicAdjust } from '../config/firebase.js';
import { state, getTrueFlockAgeWeeks, fmtMoney, fmtNum, todayISO, round2 } from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, escapeHtml } from '../core/validators.js';
import { recordCashTransaction, consumeFeedFromStock } from '../core/accounting.js';

export function renderBreeders() {
    const females = Number(state.flockData.females) || 0;
    const males = Number(state.flockData.males) || 0;
    const total = females + males;
    const trueAge = getTrueFlockAgeWeeks();

    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    setEl('activeMothersCount', fmtNum(total));
    setEl('activeFemalesCount', fmtNum(females));
    setEl('activeMalesCount', fmtNum(males));
    setEl('flockAgeDisplay', fmtNum(trueAge));
    setEl('readyEggsCount', fmtNum(state.readyEggsStock));
    setEl('tableEggsCount', fmtNum(state.tableEggsStock));
    setEl('availEggsForShelf', fmtNum(state.readyEggsStock));

    const badge = document.getElementById('fertilityBadge');
    if (badge) {
        if (total === 0) {
            badge.style.background = 'var(--text-secondary)';
            badge.textContent = 'لا يوجد قطيع';
        } else {
            const ratio = females > 0 ? males / females : 0;
            let fert = 0;
            let label = '';
            let bg = 'var(--success)';

            if (ratio >= 0.30 && ratio <= 0.52) {
                fert = trueAge > 28 ? 82 : 92;
                label = `إخصاب متوقع: ${fert}% (مثالي)`;
                bg = 'var(--success)';
            } else if (ratio > 0.52) {
                fert = 80;
                label = `إخصاب: ${fert}% (تكدس ذكور)`;
                bg = 'var(--warning)';
            } else if (ratio >= 0.20) {
                fert = 75;
                label = `إخصاب: ${fert}% (نقص ذكور)`;
                bg = 'var(--warning)';
            } else {
                fert = 50;
                label = `إخصاب: ${fert}% (خطر نقص ذكور)`;
                bg = 'var(--danger)';
            }
            badge.style.background = bg;
            badge.textContent = label;
        }
    }

    renderBreedersRecentLogs();
}

function renderBreedersRecentLogs() {
    const el = document.getElementById('breedersRecentLogs');
    if (!el) return;

    const logs = Object.values(state.breedersLogs || {})
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 8);

    if (logs.length === 0) {
        el.innerHTML = '<div class="empty-state">لا توجد سجلات فرز بيض بعد.</div>';
        return;
    }

    el.innerHTML = logs.map((l) => {
        const tablePart = l.tableEggs ? ` | مائدة: <b>${l.tableEggs}</b>` : '';
        return `
        <div class="mini-log-row">
            <div>
                <strong>${escapeHtml(l.date || '-')}</strong>
                <span class="sub-text"> (${l.daysCount > 1 ? l.daysCount + ' أيام' : 'يومي'})</span>
                <div class="sub-text">إجمالي: ${l.total} | صالح للتفريخ: <b class="text-success">${l.good}</b>${tablePart} | كسر: <b class="text-danger">${l.bad}</b></div>
            </div>
            <div style="text-align:left;">
                <span class="badge" style="background:${Number(l.prodRate) >= 75 ? 'var(--success)' : 'var(--warning)'};">إنتاج ${l.prodRate}%</span>
            </div>
        </div>`;
    }).join('');
}

export function openFlockSetupModal() {
    const fEl = document.getElementById('manualFemalesCount');
    const mEl = document.getElementById('manualMalesCount');
    const dEl = document.getElementById('flockEntryDateInput');
    const aEl = document.getElementById('flockInitialAgeWeeks');
    const cEl = document.getElementById('flockInitialCost');

    if (fEl) fEl.value = state.flockData.females || 0;
    if (mEl) mEl.value = state.flockData.males || 0;
    if (dEl) dEl.value = state.flockData.entryDate || todayISO();
    if (aEl) aEl.value = state.flockData.initialAgeWeeks || 0;
    if (cEl) cEl.value = '';

    openModal('modalFlockUpdate');
}

export async function updateFlockLedger() {
    await withActionLock('updateFlock', async () => {
        const females = parsePositiveNumber(document.getElementById('manualFemalesCount')?.value, 'عدد الإناث', { allowZero: true, isInt: true });
        const males = parsePositiveNumber(document.getElementById('manualMalesCount')?.value, 'عدد الذكور', { allowZero: true, isInt: true });
        const initialAgeWeeks = parsePositiveNumber(document.getElementById('flockInitialAgeWeeks')?.value, 'عمر القطيع عند الدخول', { allowZero: true, isInt: true });
        const cost = parsePositiveNumber(document.getElementById('flockInitialCost')?.value || '0', 'تكلفة التأسيس', { allowZero: true });
        const entryDate = document.getElementById('flockEntryDateInput')?.value || '';

        if (females === null || males === null || initialAgeWeeks === null || cost === null) return;
        if (!entryDate) return showToast('برجاء تحديد تاريخ دخول القطيع', true);

        await set(ref(db, 'inventory/flockData'), {
            females,
            males,
            entryDate,
            initialAgeWeeks
        });

        if (cost > 0) {
            await recordCashTransaction({
                type: 'out',
                amount: cost,
                desc: `تأسيس/تجديد قطيع أمهات (${females} إناث، ${males} ذكور)`,
                batchId: 'breeders',
                category: 'flock_setup'
            });
        }

        closeModal('modalFlockUpdate');
        showToast('تم حفظ بيانات قطيع الأمهات بنجاح 🕊️');
    }, 'جاري حفظ بيانات القطيع...');
}

export function openBreederDailyModal() {
    ['bdDeadFemales', 'bdDeadMales', 'bdCulledFemales', 'bdCulledMales', 'bdCulledRevenue', 'bdFeed'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '0';
    });
    openModal('modalBreederDaily');
}

export async function saveBreederDailyLog() {
    await withActionLock('breederDaily', async () => {
        const deadF = parsePositiveNumber(document.getElementById('bdDeadFemales')?.value || '0', 'نافق الإناث', { allowZero: true, isInt: true });
        const deadM = parsePositiveNumber(document.getElementById('bdDeadMales')?.value || '0', 'نافق الذكور', { allowZero: true, isInt: true });
        const culledF = parsePositiveNumber(document.getElementById('bdCulledFemales')?.value || '0', 'استبعاد الإناث', { allowZero: true, isInt: true });
        const culledM = parsePositiveNumber(document.getElementById('bdCulledMales')?.value || '0', 'استبعاد الذكور', { allowZero: true, isInt: true });
        const culledRev = parsePositiveNumber(document.getElementById('bdCulledRevenue')?.value || '0', 'إيراد بيع الاستبعاد', { allowZero: true });
        const feed = parsePositiveNumber(document.getElementById('bdFeed')?.value || '0', 'العلف المستهلك', { allowZero: true });

        if (deadF === null || deadM === null || culledF === null || culledM === null || culledRev === null || feed === null) return;

        const totalRemoveF = deadF + culledF;
        const totalRemoveM = deadM + culledM;

        if (totalRemoveF === 0 && totalRemoveM === 0 && feed === 0 && culledRev === 0) {
            return showToast('برجاء إدخال بيان واحد على الأقل', true);
        }
        if (totalRemoveF > state.flockData.females) {
            return showToast(`الإناث المخصومة (${totalRemoveF}) أكبر من الموجود (${state.flockData.females})!`, true);
        }
        if (totalRemoveM > state.flockData.males) {
            return showToast(`الذكور المخصومة (${totalRemoveM}) أكبر من الموجود (${state.flockData.males})!`, true);
        }

        if (feed > 0) {
            await consumeFeedFromStock({
                qtyKg: feed,
                batchId: 'breeders',
                desc: `علف أمهات بياض (${feed} كجم)`
            });
        }

        if (totalRemoveF > 0) {
            await atomicAdjust('inventory/flockData/females', -totalRemoveF, { allowNegative: false, decimals: 0 });
        }
        if (totalRemoveM > 0) {
            await atomicAdjust('inventory/flockData/males', -totalRemoveM, { allowNegative: false, decimals: 0 });
        }

        if (culledRev > 0) {
            await recordCashTransaction({
                type: 'in',
                amount: culledRev,
                desc: `بيع استبعاد أمهات (${culledF} إناث، ${culledM} ذكور)`,
                batchId: 'breeders',
                category: 'breeder_cull_sale'
            });
        }

        await push(ref(db, 'breedersHistoryLogs'), {
            date: todayISO(),
            deadFemales: deadF,
            deadMales: deadM,
            culledFemales: culledF,
            culledMales: culledM,
            culledRevenue: culledRev,
            feedConsumed: feed,
            timestamp: Date.now()
        });

        closeModal('modalBreederDaily');
        showToast('تم تسجيل يومية الأمهات وتحديث الأرصدة 📝');
    }, 'جاري تسجيل يومية الأمهات...');
}

export function openTriageModal() {
    const mode = document.getElementById('triagePeriodMode');
    if (mode) mode.value = 'daily';
    toggleTriagePeriod();
    ['triageTotal', 'triageTableEggs', 'triageBad'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '0';
    });
    const d1 = document.getElementById('triageStartDate');
    const d2 = document.getElementById('triageEndDate');
    if (d1) d1.value = todayISO();
    if (d2) d2.value = todayISO();
    openModal('modalDailyTriage');
}

export function toggleTriagePeriod() {
    const mode = document.getElementById('triagePeriodMode')?.value;
    const el = document.getElementById('triagePeriodDates');
    if (el) el.style.display = mode === 'period' ? 'grid' : 'none';
}

export async function processTriage() {
    await withActionLock('triage', async () => {
        const total = parsePositiveNumber(document.getElementById('triageTotal')?.value, 'إجمالي البيض', { isInt: true });
        const tableEggs = parsePositiveNumber(document.getElementById('triageTableEggs')?.value || '0', 'بيض المائدة', { allowZero: true, isInt: true });
        const bad = parsePositiveNumber(document.getElementById('triageBad')?.value || '0', 'البيض المكسور/المعدم', { allowZero: true, isInt: true });
        const mode = document.getElementById('triagePeriodMode')?.value || 'daily';

        if (total === null || tableEggs === null || bad === null) return;
        if (tableEggs + bad > total) {
            return showToast('مجموع بيض المائدة والكسر أكبر من إجمالي البيض!', true);
        }
        if ((state.flockData.females || 0) <= 0) {
            return showToast('قم بتأسيس عدد الإناث أولاً قبل الفرز!', true);
        }

        let daysCount = 1;
        let dateText = 'الإنتاج اليومي';
        if (mode === 'period') {
            const start = document.getElementById('triageStartDate')?.value;
            const end = document.getElementById('triageEndDate')?.value;
            if (!start || !end) return showToast('برجاء تحديد تواريخ الفترة', true);
            const d1 = new Date(start);
            const d2 = new Date(end);
            if (d2 < d1) return showToast('تاريخ النهاية يجب أن يكون بعد البداية', true);
            daysCount = Math.floor((d2 - d1) / 86400000) + 1;
            dateText = `إنتاج متراكم (${daysCount} أيام)`;
        }

        const good = total - tableEggs - bad;
        const validRate = Number(((good / total) * 100).toFixed(1));
        const females = state.flockData.females;
        const prodRate = Number(((total / (females * daysCount)) * 100).toFixed(1));
        const trueAge = getTrueFlockAgeWeeks();

        if (good > 0) {
            await atomicAdjust('inventory/readyEggsStock', good, { allowNegative: false, decimals: 0 });
        }
        if (tableEggs > 0) {
            await atomicAdjust('inventory/tableEggsStock', tableEggs, { allowNegative: false, decimals: 0 });
        }

        await push(ref(db, 'breedersLogs'), {
            date: todayISO(),
            mode,
            daysCount,
            females,
            flockAge: trueAge,
            total,
            good,
            tableEggs,
            bad,
            validRate,
            prodRate,
            timestamp: Date.now()
        });

        let warnings = '';
        if (trueAge >= 28) {
            warnings += `<li><strong>تنبيه إحلال:</strong> عمر القطيع الحقيقي وصل ${trueAge} أسبوع — جهّز قطيع إحلال قريباً.</li>`;
        }
        if (validRate < 85) {
            warnings += `<li><strong>نسبة الصالح للتفريخ (${validRate}%) منخفضة:</strong> راجع الكالسيوم وفيتامين D3 وتكثيف جمع البيض.</li>`;
        }
        if (prodRate < 75) {
            warnings += `<li><strong>معدل وضع البيض (${prodRate}%) أقل من المستهدف (75%+):</strong> راجع الإضاءة (15–16 ساعة) وبروتين العلف (18–20%).</li>`;
        }

        const reportHtml = `
            <div class="info-box">
                <div><strong>${dateText}:</strong> ${fmtNum(total)} بيضة من ${fmtNum(females)} أنثى</div>
                <div class="text-success"><strong>صالح للتفريخ (أضيف للمخزن):</strong> ${fmtNum(good)} (${validRate}%)</div>
                <div style="color:var(--info);"><strong>بيض مائدة قابل للبيع:</strong> ${fmtNum(tableEggs)}</div>
                <div class="text-danger"><strong>كسر / معدم:</strong> ${fmtNum(bad)}</div>
                <div style="margin-top:8px;"><strong>كفاءة الإنتاج:</strong> <span class="badge" style="background:${prodRate >= 75 ? 'var(--success)' : 'var(--warning)'};">${prodRate}%</span></div>
            </div>
            ${warnings ? `<div class="alert-box alert-danger"><h4><i class="fas fa-exclamation-triangle"></i> توصيات المستشار الفني:</h4><ul>${warnings}</ul></div>` : `<div class="alert-box alert-success">✅ الإنتاج وجودة القشرة ضمن المعدلات الممتازة.</div>`}
        `;

        const contentEl = document.getElementById('triageReportContent');
        if (contentEl) contentEl.innerHTML = reportHtml;

        closeModal('modalDailyTriage');
        openModal('modalTriageReport');
    }, 'جاري تحليل وحفظ الفرز...');
}

export function openSellTableEggsModal() {
    if ((state.tableEggsStock || 0) <= 0) {
        return showToast('لا يوجد رصيد بيض مائدة للبيع حالياً', true);
    }
    const availEl = document.getElementById('sellTableEggsAvail');
    const qtyEl = document.getElementById('sellTableEggsQty');
    const priceEl = document.getElementById('sellTableEggsPrice');
    if (availEl) availEl.textContent = fmtNum(state.tableEggsStock);
    if (qtyEl) qtyEl.value = state.tableEggsStock;
    if (priceEl) priceEl.value = state.settings.quailEgg || 1.5;
    calcTableEggsTotal();
    openModal('modalSellTableEggs');
}

export function calcTableEggsTotal() {
    const qty = parseInt(document.getElementById('sellTableEggsQty')?.value, 10) || 0;
    const price = parseFloat(document.getElementById('sellTableEggsPrice')?.value) || 0;
    const el = document.getElementById('sellTableEggsTotalDisplay');
    if (el) el.textContent = `${fmtMoney(round2(qty * price))} ج.م`;
}

export async function confirmSellTableEggs() {
    await withActionLock('sellTableEggs', async () => {
        const qty = parsePositiveNumber(document.getElementById('sellTableEggsQty')?.value, 'عدد بيض المائدة', { isInt: true });
        const price = parsePositiveNumber(document.getElementById('sellTableEggsPrice')?.value, 'سعر البيضة');
        if (qty === null || price === null) return;
        if (qty > state.tableEggsStock) {
            return showToast(`المتاح للبيع ${state.tableEggsStock} بيضة فقط`, true);
        }

        const total = round2(qty * price);
        await atomicAdjust('inventory/tableEggsStock', -qty, { allowNegative: false, decimals: 0 });
        await recordCashTransaction({
            type: 'in',
            amount: total,
            desc: `بيع بيض مائدة (${qty} بيضة × ${price} ج)`,
            batchId: 'breeders',
            category: 'table_eggs_sale'
        });

        closeModal('modalSellTableEggs');
        showToast(`تم بيع ${qty} بيضة مائدة بإيراد ${fmtMoney(total)} ج.م 🥚`);
    }, 'جاري تسجيل البيع...');
}

export function openBreederGuide() {
    const total = (state.flockData.females || 0) + (state.flockData.males || 0);
    if (total === 0) return showToast('قم بإدخال قطيع الأمهات أولاً!', true);

    const trueAge = getTrueFlockAgeWeeks();
    const feedRec = (total * 0.033).toFixed(1);
    const waterRec = (Number(feedRec) * 2.5).toFixed(1);

    const html = `
        <div class="info-box" style="text-align:center; margin-bottom:12px;">
            <span class="sub-text">العمر الحقيقي للقطيع</span>
            <div style="font-size:22px; font-weight:800; color:var(--primary);">${trueAge} أسبوع</div>
        </div>
        <div class="grid-2">
            <div class="guide-tile border-danger">
                <span class="sub-text">🌡️ الحرارة المثالية</span>
                <strong>21°C - 24°C</strong>
            </div>
            <div class="guide-tile border-warning">
                <span class="sub-text">💡 الإضاءة اليومية</span>
                <strong>15 - 16 ساعة متصلة</strong>
            </div>
            <div class="guide-tile border-success">
                <span class="sub-text">🌾 العلف اليومي (${fmtNum(total)} طائر)</span>
                <strong>${feedRec} كجم</strong>
                <div class="sub-text">بياض بروتين 19-20% | كالسيوم 3%</div>
            </div>
            <div class="guide-tile border-info">
                <span class="sub-text">💧 المياه اليومية</span>
                <strong>${waterRec} لتر</strong>
            </div>
        </div>
        ${trueAge >= 28 ? `<div class="alert-box alert-danger" style="margin-top:12px;"><strong>⚠️ تنبيه استراتيجي:</strong> القطيع تخطى 28 أسبوع — يُنصح بتجهيز قطيع إحلال فوراً للحفاظ على الإخصاب والإنتاج.</div>` : ''}
    `;

    const el = document.getElementById('breederGuideContent');
    if (el) el.innerHTML = html;
    openModal('modalBreederGuide');
}
