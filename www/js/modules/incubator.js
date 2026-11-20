// www/js/modules/incubator.js
// إدارة المفرخ وخريطة الأرفف التفاعلية + الربط الثنائي بالدفعات + الدمج الذكي لنفس اليوم

import { db, ref, set, push, update, remove, atomicAdjust, syncBatchToCRM } from '../config/firebase.js';
import {
    state, getBirdStandard, fmtMoney, fmtNum, nowLocalInput, toLocalInput, round2
} from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, parseRequiredText, escapeHtml } from '../core/validators.js';
import { recordCashTransaction } from '../core/accounting.js';

export function renderIncubatorGrid() {
    const grid = document.getElementById('incubatorGrid');
    if (!grid) return;

    const totalShelves = Math.max(1, Number(state.settings.setIncShelves) || 12);
    const std = getBirdStandard('quail');
    const now = new Date();
    let html = '';

    for (let i = 1; i <= totalShelves; i++) {
        const shelf = state.incubatorGrid[`shelf_${i}`];
        if (!shelf) {
            html += `
            <div class="shelf-card shelf-empty" onclick="openShelfSetup(${i})">
                <div class="sub-text">الرف ${i}</div>
                <div class="text-success" style="font-weight:700; margin-top:4px;">
                    <i class="fas fa-plus-circle"></i> فارغ
                </div>
            </div>`;
        } else {
            const insertD = new Date(shelf.insertDate);
            const hatcherD = new Date(insertD.getTime() + std.hatcher * 86400000);
            const hatchD = new Date(insertD.getTime() + std.hatch * 86400000);
            const daysToHatcher = Math.ceil((hatcherD - now) / 86400000);
            const daysToHatch = Math.ceil((hatchD - now) / 86400000);

            let statusTag = '';
            if (daysToHatcher > 0) {
                statusTag = `<span class="shelf-status text-info">تحضين (باقي ${daysToHatcher} ي للمفقس)</span>`;
            } else if (daysToHatch > 0) {
                statusTag = `<span class="shelf-status text-warning">انقل للمفقس! (فقس بعد ${daysToHatch} ي)</span>`;
            } else {
                statusTag = `<span class="shelf-status text-danger">موعد الفقس الآن 🐣</span>`;
            }

            const linkedBatch = shelf.batchId ? state.batches[shelf.batchId] : null;
            const batchHint = linkedBatch ? `<div class="sub-text" style="font-size:10px;">${escapeHtml(linkedBatch.name)}</div>` : '';

            html += `
            <div class="shelf-card shelf-occupied">
                <button class="shelf-clear-btn" onclick="emptyShelf(${i})" title="تفريغ الرف"><i class="fas fa-times-circle"></i></button>
                <div style="font-size:12px; font-weight:700; color:var(--primary);">الرف ${i}</div>
                <div style="font-size:16px; font-weight:800; margin:2px 0;">${fmtNum(shelf.qty)} بيضة</div>
                ${batchHint}
                ${statusTag}
            </div>`;
        }
    }

    grid.innerHTML = html;
}

export async function clearShelvesForBatch(batchId) {
    if (!batchId || !state.incubatorGrid) return;
    const updates = {};
    Object.keys(state.incubatorGrid).forEach((key) => {
        if (state.incubatorGrid[key]?.batchId === batchId) {
            updates[key] = null;
        }
    });
    if (Object.keys(updates).length > 0) {
        await update(ref(db, 'incubatorGrid'), updates);
    }
}

export function openShelfSetup(shelfNum) {
    const numEl = document.getElementById('selectedShelfNum');
    const idEl = document.getElementById('selectedShelfId');
    const qtyEl = document.getElementById('shelfLoadQty');
    const dateEl = document.getElementById('shelfLoadDate');
    const typeEl = document.getElementById('shelfLoadType');
    const availEl = document.getElementById('availEggsForShelf');

    if (numEl) numEl.textContent = shelfNum;
    if (idEl) idEl.value = shelfNum;
    if (qtyEl) qtyEl.value = '';
    if (typeEl) typeEl.value = 'single';
    if (availEl) availEl.textContent = fmtNum(state.readyEggsStock);
    if (dateEl) dateEl.value = nowLocalInput();

    toggleShelfInputs();
    openModal('modalShelfSetup');
}

export function toggleShelfInputs() {
    const type = document.getElementById('shelfLoadType')?.value;
    const multiContainer = document.getElementById('multiShelfContainer');
    if (multiContainer) multiContainer.style.display = type === 'multi' ? 'block' : 'none';
    calcShelfDist();
}

export function calcShelfDist() {
    const type = document.getElementById('shelfLoadType')?.value;
    const totalEggs = parseInt(document.getElementById('shelfLoadQty')?.value, 10) || 0;
    const hint = document.getElementById('shelfDistHint');
    if (!hint) return;

    const totalShelves = Math.max(1, Number(state.settings.setIncShelves) || 12);
    const shelfCap = Math.max(1, Number(state.settings.setIncShelfCapacity) || 500);
    let shelvesCount = 1;

    if (type === 'multi') {
        shelvesCount = Math.max(1, parseInt(document.getElementById('multiShelfCount')?.value, 10) || 1);
    } else if (type === 'full') {
        let empty = 0;
        for (let i = 1; i <= totalShelves; i++) {
            if (!state.incubatorGrid[`shelf_${i}`]) empty++;
        }
        shelvesCount = empty;
    }

    if (shelvesCount > 0 && totalEggs > 0) {
        const perShelf = Math.ceil(totalEggs / shelvesCount);
        const capWarn = perShelf > shelfCap
            ? `<div class="text-danger" style="margin-top:4px;">⚠️ تنبيه: ${perShelf} بيضة تتخطى سعة الرف المبرمجة (${shelfCap} بيضة)!</div>`
            : '';
        hint.innerHTML = `<i class="fas fa-layer-group"></i> توزيع <b>${fmtNum(totalEggs)} بيضة</b> على <b>${shelvesCount} أرفف</b> (~${fmtNum(perShelf)} بيضة/رف).${capWarn}`;
    } else {
        hint.innerHTML = '';
    }
}

export async function loadIncubatorShelf() {
    await withActionLock('loadShelf', async () => {
        const startShelfNum = parseInt(document.getElementById('selectedShelfId')?.value, 10);
        const type = document.getElementById('shelfLoadType')?.value || 'single';
        const dateStr = document.getElementById('shelfLoadDate')?.value;
        const totalEggs = parsePositiveNumber(document.getElementById('shelfLoadQty')?.value, 'عدد البيض', { isInt: true });

        if (totalEggs === null) return;
        if (!dateStr) return showToast('برجاء تحديد تاريخ الدخول', true);
        if (totalEggs > state.readyEggsStock) {
            return showToast(`رصيد البيض الجاهز (${state.readyEggsStock}) لا يكفي!`, true);
        }

        const totalShelves = Math.max(1, Number(state.settings.setIncShelves) || 12);
        let targetCount = 1;

        if (type === 'multi') {
            targetCount = parsePositiveNumber(document.getElementById('multiShelfCount')?.value, 'عدد الأرفف', { isInt: true });
            if (targetCount === null) return;
        } else if (type === 'full') {
            targetCount = 0;
            for (let i = 1; i <= totalShelves; i++) {
                if (!state.incubatorGrid[`shelf_${i}`]) targetCount++;
            }
        }

        if (targetCount <= 0) return showToast('لا توجد أرفف فارغة!', true);

        const emptyShelves = [];
        if (!state.incubatorGrid[`shelf_${startShelfNum}`]) emptyShelves.push(startShelfNum);
        for (let i = 1; i <= totalShelves && emptyShelves.length < targetCount; i++) {
            if (i !== startShelfNum && !state.incubatorGrid[`shelf_${i}`]) emptyShelves.push(i);
        }

        if (emptyShelves.length < targetCount) {
            return showToast(`الأرفف الفارغة المتاحة (${emptyShelves.length}) أقل من المطلوب (${targetCount})`, true);
        }

        // الدمج الذكي: لو توجد دفعة سمان بالماكينة دخلت في نفس اليوم، ندمج الأرفف معها
        const dateOnly = dateStr.split('T')[0];
        let existingBatchId = null;
        for (const [bId, b] of Object.entries(state.batches)) {
            if (b.status === 'incubator' && (b.birdType || 'quail') === 'quail' && (b.insertDate || '').startsWith(dateOnly)) {
                existingBatchId = bId;
                break;
            }
        }

        const batchIdToUse = existingBatchId || push(ref(db, 'batches')).key;
        const perShelf = Math.floor(totalEggs / targetCount);
        const remainder = totalEggs % targetCount;
        const gridUpdates = {};

        emptyShelves.forEach((sNum, idx) => {
            gridUpdates[`shelf_${sNum}`] = {
                qty: perShelf + (idx === 0 ? remainder : 0),
                insertDate: dateStr,
                batchId: batchIdToUse
            };
        });

        await atomicAdjust('inventory/readyEggsStock', -totalEggs, { allowNegative: false, decimals: 0 });
        await update(ref(db, 'incubatorGrid'), gridUpdates);

        if (existingBatchId) {
            await atomicAdjust(`batches/${existingBatchId}/initialEggs`, totalEggs, { allowNegative: false, decimals: 0 });
            showToast(`تم التحميل والدمج الذكي مع دفعة يوم ${dateOnly} 🚀`);
        } else {
            const std = getBirdStandard('quail');
            const insertD = new Date(dateStr);
            const hatcherD = new Date(insertD.getTime() + std.hatcher * 86400000);
            const hatchD = new Date(insertD.getTime() + std.hatch * 86400000);
            const rearD = new Date(hatchD.getTime() + std.slaughter * 86400000);

            await set(ref(db, `batches/${batchIdToUse}`), {
                name: `دفعة ${dateOnly}`,
                birdType: 'quail',
                insertDate: dateStr,
                hatcherDate: hatcherD.toISOString(),
                hatchDate: hatchD.toISOString(),
                rearDate: rearD.toISOString(),
                slaughterAge: std.slaughter,
                initialEggs: totalEggs,
                status: 'incubator',
                totalDead: 0,
                totalFeed: 0,
                order: Date.now()
            });
            showToast(`تم إدخال الدفعة وتوزيعها على ${targetCount} أرفف 🚀`);
        }

        closeModal('modalShelfSetup');
    }, 'جاري تحميل الأرفف...');
}

export async function emptyShelf(shelfNum) {
    const shelf = state.incubatorGrid[`shelf_${shelfNum}`];
    if (!shelf) return;
    if (!confirm(`هل تريد تفريغ الرف رقم ${shelfNum} (${shelf.qty} بيضة)؟`)) return;

    await withActionLock(`emptyShelf_${shelfNum}`, async () => {
        await remove(ref(db, `incubatorGrid/shelf_${shelfNum}`));

        if (shelf.batchId && state.batches[shelf.batchId]?.status === 'incubator') {
            const shouldDeduct = confirm('هل تريد أيضاً خصم بيض هذا الرف من إجمالي الدفعة المرتبطة به في المفرخ؟');
            if (shouldDeduct) {
                const curEggs = Number(state.batches[shelf.batchId].initialEggs) || 0;
                const nextEggs = Math.max(0, curEggs - (Number(shelf.qty) || 0));
                await update(ref(db, `batches/${shelf.batchId}`), { initialEggs: nextEggs });
            }
        }
        showToast(`تم تفريغ الرف ${shelfNum} بنجاح`);
    });
}

// ================= إضافة وتعديل الدفعات =================
export function openNewBatchModal() {
    const typeEl = document.getElementById('bBirdType');
    const dateEl = document.getElementById('bDate');
    const eggsEl = document.getElementById('bEggs');
    const nameEl = document.getElementById('bName');

    const defaultType = state.settings.birdType || 'quail';
    if (typeEl) typeEl.value = defaultType;
    if (eggsEl) eggsEl.value = '';
    if (dateEl) dateEl.value = nowLocalInput();
    if (nameEl && dateEl) nameEl.value = `دفعة ${dateEl.value.split('T')[0]}`;

    const std = getBirdStandard(defaultType);
    const slEl = document.getElementById('bSlaughterDays');
    if (slEl) slEl.value = std.slaughter;

    autoCalcDates();
    openModal('modalBatch');
}

export function autoCalcDates(resetSlaughterFromType = false) {
    const type = document.getElementById('bBirdType')?.value || 'quail';
    const dateStr = document.getElementById('bDate')?.value;
    if (!dateStr) return;

    const std = getBirdStandard(type);
    const slEl = document.getElementById('bSlaughterDays');
    if (resetSlaughterFromType && slEl) {
        slEl.value = std.slaughter;
    }

    const insertD = new Date(dateStr);
    if (isNaN(insertD.getTime())) return;

    const hatcherD = new Date(insertD.getTime() + std.hatcher * 86400000);
    const hatchD = new Date(insertD.getTime() + std.hatch * 86400000);
    const slDays = parseInt(slEl?.value, 10) || std.slaughter;
    const rearD = new Date(hatchD.getTime() + slDays * 86400000);

    const h1 = document.getElementById('bHatcherDate');
    const h2 = document.getElementById('bHatchDate');
    const h3 = document.getElementById('bSlaughterDate');
    if (h1) h1.value = toLocalInput(hatcherD);
    if (h2) h2.value = toLocalInput(hatchD);
    if (h3) h3.value = toLocalInput(rearD);

    const nameEl = document.getElementById('bName');
    if (nameEl) nameEl.value = `دفعة ${dateStr.split('T')[0]}`;
}

export async function saveNewBatch() {
    await withActionLock('saveNewBatch', async () => {
        const name = parseRequiredText(document.getElementById('bName')?.value, 'اسم الدفعة');
        const eggs = parsePositiveNumber(document.getElementById('bEggs')?.value, 'عدد البيض', { isInt: true });
        const datetimeStr = document.getElementById('bDate')?.value;
        const bType = document.getElementById('bBirdType')?.value || 'quail';
        const hatcherD = document.getElementById('bHatcherDate')?.value;
        const hatchD = document.getElementById('bHatchDate')?.value;
        const rearD = document.getElementById('bSlaughterDate')?.value;
        const slDays = parseInt(document.getElementById('bSlaughterDays')?.value, 10) || getBirdStandard(bType).slaughter;

        if (!name || eggs === null) return;
        if (!datetimeStr || !hatcherD || !hatchD || !rearD) {
            return showToast('برجاء إكمال جميع التواريخ المتوقعة', true);
        }

        const newRef = push(ref(db, 'batches'));
        await set(newRef, {
            name,
            birdType: bType,
            insertDate: datetimeStr,
            hatcherDate: new Date(hatcherD).toISOString(),
            hatchDate: new Date(hatchD).toISOString(),
            rearDate: new Date(rearD).toISOString(),
            slaughterAge: slDays,
            initialEggs: eggs,
            status: 'incubator',
            totalDead: 0,
            totalFeed: 0,
            order: Date.now()
        });

        closeModal('modalBatch');
        showToast(`تمت إضافة "${name}" بالمفرخ بنجاح 🥚`);
    }, 'جاري حفظ الدفعة...');
}

export function openEditBatch(id) {
    const b = state.batches[id];
    if (!b) return;

    document.getElementById('editBatchId').value = id;
    document.getElementById('editBatchStage').value = b.status || 'incubator';
    document.getElementById('editBName').value = b.name || '';

    const isRearing = b.status === 'rearing';
    const qtyLabel = document.getElementById('editQtyLabel');
    const dateLabel = document.getElementById('editDateLabel');
    if (qtyLabel) qtyLabel.textContent = isRearing ? 'عدد الكتاكيت عند الفقس' : 'عدد البيض بالمفرخ';
    if (dateLabel) dateLabel.textContent = isRearing ? 'تاريخ الفقس (بداية التربية)' : 'تاريخ الدخول للماكينة';

    document.getElementById('editBEggs').value = isRearing ? (b.hatchedChicks || 0) : (b.initialEggs || 0);
    document.getElementById('editBDate').value = toLocalInput(isRearing ? b.hatchDate : b.insertDate);

    const rearSec = document.getElementById('editRearingSection');
    if (rearSec) {
        rearSec.style.display = isRearing ? 'block' : 'none';
        if (isRearing) {
            document.getElementById('editSlaughterAge').value = b.slaughterAge || getBirdStandard(b.birdType || 'quail').slaughter;
            document.getElementById('editSlaughterDate').value = toLocalInput(b.rearDate);
        }
    }

    openModal('modalEditBatch');
}

export function syncEditSlaughterDate() {
    const stage = document.getElementById('editBatchStage')?.value;
    if (stage !== 'rearing') return;
    const baseDate = document.getElementById('editBDate')?.value;
    const age = parseInt(document.getElementById('editSlaughterAge')?.value, 10) || 0;
    if (!baseDate || age <= 0) return;
    const d = new Date(baseDate);
    if (isNaN(d.getTime())) return;
    const target = new Date(d.getTime() + age * 86400000);
    const out = document.getElementById('editSlaughterDate');
    if (out) out.value = toLocalInput(target);
}

export async function saveEditBatch() {
    await withActionLock('saveEditBatch', async () => {
        const id = document.getElementById('editBatchId')?.value;
        const b = state.batches[id];
        if (!b) return;

        const newName = parseRequiredText(document.getElementById('editBName')?.value, 'اسم الدفعة');
        const newQty = parsePositiveNumber(document.getElementById('editBEggs')?.value, 'العدد', { isInt: true });
        const newDateStr = document.getElementById('editBDate')?.value;

        if (!newName || newQty === null || !newDateStr) return;

        const std = getBirdStandard(b.birdType || 'quail');
        const updateData = { name: newName };

        if (b.status === 'incubator' || b.status === 'hatcher') {
            const insertD = new Date(newDateStr);
            const slDays = b.slaughterAge || std.slaughter;
            updateData.initialEggs = newQty;
            updateData.insertDate = newDateStr;
            updateData.hatcherDate = new Date(insertD.getTime() + std.hatcher * 86400000).toISOString();
            updateData.hatchDate = new Date(insertD.getTime() + std.hatch * 86400000).toISOString();
            updateData.rearDate = new Date(insertD.getTime() + (std.hatch + slDays) * 86400000).toISOString();
        } else if (b.status === 'rearing') {
            const customAge = parsePositiveNumber(document.getElementById('editSlaughterAge')?.value, 'عمر الذبح', { isInt: true });
            const customDate = document.getElementById('editSlaughterDate')?.value;
            if (customAge === null || !customDate) return;

            updateData.hatchedChicks = newQty;
            updateData.hatchDate = new Date(newDateStr).toISOString();
            updateData.slaughterAge = customAge;
            updateData.rearDate = new Date(customDate).toISOString();
            if (b.initialEggs > 0) {
                updateData.hatchRate = Number(((newQty / b.initialEggs) * 100).toFixed(1));
            }
        }

        await update(ref(db, `batches/${id}`), updateData);

        // تحديث آمن في الـ CRM لو الدفعة في التربية (بدون المساس بحجوزات العملاء)
        if (b.status === 'rearing') {
            try {
                const bufferDays = Number(state.settings.crmExtraBufferDays ?? 5);
                await syncBatchToCRM(id, {
                    name: newName,
                    slaughterAge: (updateData.slaughterAge || std.slaughter) + bufferDays
                }, false);
            } catch (e) {
                console.warn('CRM name/date patch skipped:', e);
            }
        }

        closeModal('modalEditBatch');
        showToast('تم حفظ تعديلات الدفعة بنجاح ✏️');
    }, 'جاري حفظ التعديلات...');
}

export async function updateStage(id, newStage) {
    const b = state.batches[id];
    if (!b) return;
    if (newStage === 'slaughter' && !confirm(`⚠️ هل أنت متأكد من نقل الدفعة "${b.name}" لمرحلة الذبح والتجهيز؟`)) return;

    await withActionLock(`stage_${id}`, async () => {
        await update(ref(db, `batches/${id}`), { status: newStage });
        // عند النقل من التحضين إلى المفقس، نفرّغ أرفف التحضين المرتبطة أوتوماتيكياً لمنع الأرفف الشبحية
        if (newStage === 'hatcher') {
            await clearShelvesForBatch(id);
        }
        showToast('تم تحديث مرحلة الدفعة بنجاح');
    });
}

export async function deleteBatch(id) {
    const b = state.batches[id];
    if (!b) return;
    if (!confirm(`⚠️ هل أنت متأكد من حذف الدفعة "${b.name}" نهائياً؟`)) return;

    await withActionLock(`delBatch_${id}`, async () => {
        await clearShelvesForBatch(id);
        await remove(ref(db, `batches/${id}`));
        showToast('تم حذف الدفعة وتنظيف أرففها المرتبطة');
    });
}

// ================= بيع بيض من المفرخ (بسعر البيض الحقيقي) =================
export function openSellEggsModal(batchId) {
    const b = state.batches[batchId];
    if (!b) return;

    let eggPrice = Number(state.settings.quailEgg) || 1.5;
    if (b.birdType === 'chicken') eggPrice = Number(state.settings.chickenEgg) || 10;
    else if (b.birdType === 'turkey') eggPrice = Number(state.settings.turkeyEgg) || 25;

    document.getElementById('sellEggsBatchId').value = batchId;
    document.getElementById('sellEggsBatchName').textContent = b.name;
    document.getElementById('sellEggsAvail').textContent = fmtNum(b.initialEggs || 0);
    document.getElementById('sellEggsQty').value = '';
    document.getElementById('sellEggsUnitPrice').value = eggPrice;
    calcSellEggsTotal();
    openModal('modalSellEggs');
}

export function calcSellEggsTotal() {
    const qty = parseInt(document.getElementById('sellEggsQty')?.value, 10) || 0;
    const price = parseFloat(document.getElementById('sellEggsUnitPrice')?.value) || 0;
    const el = document.getElementById('sellEggsTotalDisplay');
    if (el) el.textContent = `${fmtMoney(round2(qty * price))} ج.م`;
}

export async function confirmSellEggs() {
    await withActionLock('sellIncEggs', async () => {
        const batchId = document.getElementById('sellEggsBatchId')?.value;
        const b = state.batches[batchId];
        if (!b) return;

        const qty = parsePositiveNumber(document.getElementById('sellEggsQty')?.value, 'عدد البيض المباع', { isInt: true });
        const unitPrice = parsePositiveNumber(document.getElementById('sellEggsUnitPrice')?.value, 'سعر البيضة');
        if (qty === null || unitPrice === null) return;
        if (qty > (b.initialEggs || 0)) {
            return showToast(`المتاح في الدفعة ${b.initialEggs || 0} بيضة فقط!`, true);
        }

        const total = round2(qty * unitPrice);
        await atomicAdjust(`batches/${batchId}/initialEggs`, -qty, { allowNegative: false, decimals: 0 });
        await recordCashTransaction({
            type: 'in',
            amount: total,
            desc: `بيع بيض تفريخ (${qty} × ${unitPrice} ج) - ${b.name}`,
            batchId,
            category: 'hatching_eggs_sale'
        });

        closeModal('modalSellEggs');
        showToast(`تم بيع ${qty} بيضة بإيراد ${fmtMoney(total)} ج.م 🥚`);
    }, 'جاري تسجيل بيع البيض...');
}

export async function moveBatchOrder(id, direction) {
    const target = state.batches[id];
    if (!target) return;
    const isInc = (s) => s === 'incubator' || s === 'hatcher';
    const samePhase = (s1, s2) => (isInc(s1) && isInc(s2)) || s1 === s2;

    const list = Object.keys(state.batches)
        .map((k) => ({ id: k, ...state.batches[k] }))
        .filter((b) => (b.birdType || 'quail') === (target.birdType || 'quail') && samePhase(b.status, target.status))
        .sort((a, b) => (b.order || 0) - (a.order || 0));

    const idx = list.findIndex((b) => b.id === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;

    const curOrder = list[idx].order || Date.now();
    const otherOrder = list[swapIdx].order || (curOrder + (direction === 'up' ? 1 : -1));
    await update(ref(db, `batches/${list[swapIdx].id}`), { order: curOrder });
    await update(ref(db, `batches/${id}`), { order: otherOrder });
}
