// www/js/modules/freezer.js
// إدارة الفريزر الديناميكي، تصنيف الذبح + الهالك، وخوارزمية FIFO الحقيقية وتنبيه +30 يوم

import { db, ref, set, get, push, update, remove, atomicAdjust, syncBatchToCRM } from '../config/firebase.js';
import { state, fmtMoney, fmtNum, todayISO, round2 } from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, parseRequiredText, escapeHtml } from '../core/validators.js';
import { recordCashTransaction } from '../core/accounting.js';

export function renderFreezerAll() {
    populateSaleDropdown();
    renderFreezerGrid();
    renderManageCategories();
    renderFreezerLogs();
}

function populateSaleDropdown() {
    const sel = document.getElementById('sGrade');
    if (!sel) return;
    const prev = sel.value;
    let html = '<option value="">-- اختر الصنف للبيع --</option>';
    Object.entries(state.freezerConfig).forEach(([id, item]) => {
        const stock = Number(state.freezerStock[id]) || 0;
        html += `<option value="${id}">${escapeHtml(item.name)} (متاح: ${stock} | ${fmtMoney(item.price)} ج)</option>`;
    });
    sel.innerHTML = html;
    if (prev && state.freezerConfig[prev]) sel.value = prev;
}

export function renderFreezerGrid() {
    const grid = document.getElementById('freezerGrid');
    const dashTotal = document.getElementById('dashFreezer');
    const totalValEl = document.getElementById('freezerTotalMarketValue');
    if (!grid) return;

    let totalUnits = 0;
    let totalMarketValue = 0;
    const entries = Object.entries(state.freezerConfig);

    if (entries.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">لا توجد أصناف في الفريزر. اضغط على "إدارة الأصناف" للإضافة.</div>';
    } else {
        grid.innerHTML = entries.map(([id, item]) => {
            const qty = Number(state.freezerStock[id]) || 0;
            const price = Number(item.price) || 0;
            const bpu = Number(item.birdsPerUnit) || 2;
            totalUnits += qty;
            totalMarketValue += qty * price;

            return `
            <div class="freezer-card" onclick="openEditFreezerItem('${id}')">
                <div class="freezer-icon"><i class="fas fa-snowflake"></i></div>
                <div class="freezer-name">${escapeHtml(item.name)}</div>
                <div class="freezer-qty">${fmtNum(qty)}</div>
                <div class="freezer-meta">
                    <span class="price-pill">${fmtMoney(price)} ج</span>
                    <span class="sub-text" style="font-size:11px;">(${bpu} طائر/وحدة)</span>
                </div>
            </div>`;
        }).join('');
    }

    if (dashTotal) dashTotal.textContent = fmtNum(totalUnits);
    if (totalValEl) totalValEl.textContent = `${fmtMoney(round2(totalMarketValue))} ج.م`;
}

export function openEditFreezerItem(id) {
    const item = state.freezerConfig[id];
    if (!item) return;
    document.getElementById('editFreezerId').value = id;
    document.getElementById('editFreezerName').value = item.name || '';
    document.getElementById('editFreezerQty').value = Number(state.freezerStock[id]) || 0;
    document.getElementById('editFreezerPrice').value = Number(item.price) || 0;
    document.getElementById('editFreezerBpu').value = Number(item.birdsPerUnit) || 2;
    openModal('modalEditFreezerItem');
}

export async function saveEditFreezerItem() {
    await withActionLock('editFreezer', async () => {
        const id = document.getElementById('editFreezerId')?.value;
        if (!id || !state.freezerConfig[id]) return;

        const name = parseRequiredText(document.getElementById('editFreezerName')?.value, 'اسم الصنف');
        const qty = parsePositiveNumber(document.getElementById('editFreezerQty')?.value, 'الرصيد', { allowZero: true, isInt: true });
        const price = parsePositiveNumber(document.getElementById('editFreezerPrice')?.value, 'السعر', { allowZero: true });
        const bpu = parsePositiveNumber(document.getElementById('editFreezerBpu')?.value, 'عدد الطيور بالوحدة', { isInt: true });

        if (!name || qty === null || price === null || bpu === null) return;

        await update(ref(db, `inventory/freezerConfig/${id}`), { name, price, birdsPerUnit: bpu });
        await set(ref(db, `inventory/freezerStock/${id}`), qty);

        closeModal('modalEditFreezerItem');
        showToast('تم تحديث بيانات الصنف بنجاح ❄️');
    }, 'جاري حفظ التعديلات...');
}

export function renderManageCategories() {
    const el = document.getElementById('freezerCategoriesList');
    if (!el) return;
    const entries = Object.entries(state.freezerConfig);
    if (entries.length === 0) {
        el.innerHTML = '<div class="empty-state">لا توجد أصناف مضافة حالياً.</div>';
        return;
    }

    el.innerHTML = entries.map(([id, cat]) => `
        <div class="mini-log-row">
            <div>
                <strong>${escapeHtml(cat.name)}</strong>
                <div class="sub-text">السعر: ${fmtMoney(cat.price)} ج | ${cat.birdsPerUnit || 2} طائر/وحدة</div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="deleteFreezerCategory('${id}')"><i class="fas fa-trash"></i> حذف</button>
        </div>
    `).join('');
}

export async function addCategoryFromMaster() {
    await withActionLock('addFreezerCat', async () => {
        const name = parseRequiredText(document.getElementById('masterCatName')?.value, 'اسم الصنف');
        const price = parsePositiveNumber(document.getElementById('masterCatPrice')?.value || '0', 'السعر', { allowZero: true });
        const bpu = parsePositiveNumber(document.getElementById('masterCatBpu')?.value || '2', 'عدد الطيور بالوحدة', { isInt: true });
        if (!name || price === null || bpu === null) return;

        const newId = 'cat_' + Date.now();
        await set(ref(db, `inventory/freezerConfig/${newId}`), { name, price, birdsPerUnit: bpu });
        await set(ref(db, `inventory/freezerStock/${newId}`), 0);

        document.getElementById('masterCatName').value = '';
        document.getElementById('masterCatPrice').value = '';
        document.getElementById('masterCatBpu').value = '2';
        showToast(`تمت إضافة صنف "${name}" بنجاح ❄️`);
    });
}

export async function deleteFreezerCategory(id) {
    const cat = state.freezerConfig[id];
    if (!cat) return;
    if (!confirm(`هل أنت متأكد من حذف الصنف "${cat.name}" نهائياً من الفريزر؟`)) return;
    await remove(ref(db, `inventory/freezerConfig/${id}`));
    await remove(ref(db, `inventory/freezerStock/${id}`));
    showToast('تم حذف الصنف بنجاح');
}

// ================= تصنيف الذبح مع حساب الهالك والتأكد من المطابقة =================
export function promptClassify(id) {
    const b = state.batches[id];
    if (!b) return;
    const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));

    document.getElementById('classBatchId').value = id;
    document.getElementById('classAliveCount').textContent = fmtNum(alive);

    const grid = document.getElementById('classifyInputsGrid');
    if (grid) {
        grid.innerHTML = Object.entries(state.freezerConfig).map(([catId, cat]) => `
            <div>
                <label>${escapeHtml(cat.name)} <span class="sub-text">(${cat.birdsPerUnit || 2} طائر)</span></label>
                <input type="number" min="0" id="c_${catId}" value="0" oninput="updateClassifyCounter()" onfocus="this.select()">
            </div>
        `).join('');
    }
    const lossEl = document.getElementById('c_slaughterLoss');
    if (lossEl) lossEl.value = '0';

    updateClassifyCounter();
    openModal('modalClassify');
}

export function updateClassifyCounter() {
    const id = document.getElementById('classBatchId')?.value;
    const b = state.batches[id];
    if (!b) return;
    const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));

    let classifiedBirds = 0;
    Object.entries(state.freezerConfig).forEach(([catId, cat]) => {
        const val = parseInt(document.getElementById(`c_${catId}`)?.value, 10) || 0;
        classifiedBirds += val * (Number(cat.birdsPerUnit) || 2);
    });
    const loss = parseInt(document.getElementById('c_slaughterLoss')?.value, 10) || 0;
    const totalAccounted = classifiedBirds + loss;
    const diff = alive - totalAccounted;

    const statusEl = document.getElementById('classifyMatchStatus');
    if (!statusEl) return;

    if (totalAccounted > alive) {
        statusEl.className = 'alert-box alert-danger';
        statusEl.innerHTML = `❌ تجاوز للعدد! المصنّف + الهالك = <b>${totalAccounted} طائر</b> بينما المتاح بالعنبر <b>${alive} طائر</b> فقط!`;
    } else if (diff === 0) {
        statusEl.className = 'alert-box alert-success';
        statusEl.innerHTML = `✅ مطابقة 100%! (${classifiedBirds} طائر صالح + ${loss} هالك ذبح = ${alive} طائر)`;
    } else {
        statusEl.className = 'alert-box alert-warning';
        statusEl.innerHTML = `ℹ️ تم حساب <b>${totalAccounted}</b> من أصل <b>${alive} طائر</b> (متبقي فرق: <b>${diff} طائر</b> غير مُسجَّل).`;
    }
}

export async function finishSlaughter() {
    await withActionLock('finishSlaughter', async () => {
        const id = document.getElementById('classBatchId')?.value;
        const b = state.batches[id];
        if (!b) return;

        const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));
        const loss = parsePositiveNumber(document.getElementById('c_slaughterLoss')?.value || '0', 'هالك الذبح', { allowZero: true, isInt: true });
        if (loss === null) return;

        const toAdd = {};
        let yieldUnits = 0;
        let processedBirds = 0;

        for (const [catId, cat] of Object.entries(state.freezerConfig)) {
            const raw = document.getElementById(`c_${catId}`)?.value || '0';
            const val = parsePositiveNumber(raw, cat.name, { allowZero: true, isInt: true });
            if (val === null) return;
            if (val > 0) {
                toAdd[catId] = val;
                yieldUnits += val;
                processedBirds += val * (Number(cat.birdsPerUnit) || 2);
            }
        }

        if (yieldUnits === 0 && loss === 0) {
            return showToast('برجاء إدخال ناتج التصنيف أو الهالك', true);
        }

        if (processedBirds + loss > alive) {
            return showToast(`❌ مستحيل! مجموع المصنّف والهالك (${processedBirds + loss} طائر) أكبر من المتاح (${alive} طائر)!`, true);
        }

        // 1. إضافة الأرصدة ذرياً لكل صنف في الفريزر
        for (const [catId, qty] of Object.entries(toAdd)) {
            await atomicAdjust(`inventory/freezerStock/${catId}`, qty, { allowNegative: false, decimals: 0 });
        }

        // 2. تسجيل إيداع الفريزر مع ختم الوقت لتطبيق الـ FIFO لاحقاً
        if (yieldUnits > 0) {
            await push(ref(db, 'inventory/freezerLogs'), {
                batchId: id,
                batchName: b.name,
                birdType: b.birdType || 'quail',
                dateAdded: todayISO(),
                items: { ...toAdd },         // المتبقي الحالي (يتناقص بالـ FIFO)
                initialItems: { ...toAdd },  // الكمية الأصلية للتوثيق
                timestamp: Date.now()
            });
        }

        // 3. إغلاق الدفعة كـ completed (تظهر فوراً في تقارير الربحية Batch P&L دون ازدواجية إيراد)
        await update(ref(db, `batches/${id}`), {
            status: 'completed',
            slaughterYield: yieldUnits,
            slaughterProcessedBirds: processedBirds,
            slaughterLoss: loss,
            classifyData: toAdd,
            completedDate: todayISO()
        });

        // 4. إغلاق الحجز المسبق على الدفعة في الـ CRM بأمان
        try {
            await syncBatchToCRM(id, { isOpen: false }, false);
        } catch (err) {
            console.warn('CRM close patch skipped:', err);
        }

        closeModal('modalClassify');
        showToast(`تم تصنيف الدفعة (${yieldUnits} وحدة) وترحيلها للفريزر بنجاح ❄️`);
    }, 'جاري ترحيل البضاعة للفريزر...');
}

// ================= المبيعات من الفريزر مع تطبيق خوارزمية FIFO الحقيقية =================
export function openSaleModal() {
    populateSaleDropdown();
    const qtyEl = document.getElementById('sQty');
    if (qtyEl) qtyEl.value = '';
    const customPriceEl = document.getElementById('sUnitPrice');
    if (customPriceEl) customPriceEl.value = '';
    calculateSaleTotal();
    openModal('modalSale');
}

export function onSaleGradeChange() {
    const grade = document.getElementById('sGrade')?.value;
    const priceEl = document.getElementById('sUnitPrice');
    if (priceEl) {
        priceEl.value = grade && state.freezerConfig[grade] ? (state.freezerConfig[grade].price || 0) : '';
    }
    calculateSaleTotal();
}

export function calculateSaleTotal() {
    const qty = parseInt(document.getElementById('sQty')?.value, 10) || 0;
    const unitPrice = parseFloat(document.getElementById('sUnitPrice')?.value) || 0;
    const display = document.getElementById('saleTotalDisplay');
    if (display) display.textContent = `${fmtMoney(round2(qty * unitPrice))} ج.م`;
}

export async function processSale() {
    await withActionLock('freezerSale', async () => {
        const grade = document.getElementById('sGrade')?.value;
        const qty = parsePositiveNumber(document.getElementById('sQty')?.value, 'الكمية المباعة', { isInt: true });
        const unitPrice = parsePositiveNumber(document.getElementById('sUnitPrice')?.value, 'سعر البيع');

        if (!grade || !state.freezerConfig[grade]) return showToast('برجاء اختيار الصنف', true);
        if (qty === null || unitPrice === null) return;

        const avail = Number(state.freezerStock[grade]) || 0;
        if (qty > avail) return showToast(`الرصيد لا يكفي! المتاح: ${avail}`, true);

        const totalAmount = round2(qty * unitPrice);

        // 1. خصم ذري من المخزون الكلي
        await atomicAdjust(`inventory/freezerStock/${grade}`, -qty, { allowNegative: false, decimals: 0 });

        // 2. تطبيق خوارزمية FIFO الحقيقية: الخصم من أقدم إيداعات الفريزر أولاً
        let remaining = qty;
        const sortedLogs = Object.entries(state.freezerLogs || {})
            .sort(([, a], [, b]) => {
                const ta = a.timestamp || new Date(a.dateAdded || 0).getTime();
                const tb = b.timestamp || new Date(b.dateAdded || 0).getTime();
                return ta - tb;
            });

        for (const [logId, log] of sortedLogs) {
            if (remaining <= 0) break;
            const inLog = Number(log.items?.[grade]) || 0;
            if (inLog <= 0) continue;

            if (inLog <= remaining) {
                remaining -= inLog;
                await set(ref(db, `inventory/freezerLogs/${logId}/items/${grade}`), 0);
            } else {
                await set(ref(db, `inventory/freezerLogs/${logId}/items/${grade}`), inLog - remaining);
                remaining = 0;
            }
        }

        // 3. تسجيل الإيراد المالي في المركز المالي والخزنة
        await recordCashTransaction({
            type: 'in',
            amount: totalAmount,
            desc: `مبيعات فريزر (${qty} × ${state.freezerConfig[grade].name})`,
            batchId: 'general',
            category: 'freezer_sale'
        });

        closeModal('modalSale');
        showToast(`تم بيع ${qty} من "${state.freezerConfig[grade].name}" وإضافة ${fmtMoney(totalAmount)} ج.م 💰`);
    }, 'جاري تنفيذ البيع وتطبيق FIFO...');
}

// ================= سجل إيداعات الفريزر وتنبيهات التقادم =================
export function toggleLogDeletion() {
    state.ui.isDeleteLogMode = !state.ui.isDeleteLogMode;
    renderFreezerLogs();
}

export async function deleteFreezerLog(logId) {
    if (!confirm('حذف سجل الإيداع هذا؟ (يحذف السجل فقط دون تعديل الأرصدة)')) return;
    await remove(ref(db, `inventory/freezerLogs/${logId}`));
    showToast('تم حذف السجل');
}

export function getOldFreezerAlerts() {
    const alerts = [];
    const now = Date.now();
    Object.values(state.freezerLogs || {}).forEach((log) => {
        const items = log.items || {};
        const remainingCount = Object.values(items).reduce((sum, v) => sum + (Number(v) || 0), 0);
        if (remainingCount <= 0) return;

        const daysOld = Math.floor((now - new Date(log.dateAdded || now).getTime()) / 86400000);
        if (daysOld >= 30) {
            alerts.push({ batchName: log.batchName, daysOld, remainingCount });
        }
    });
    return alerts;
}

export function renderFreezerLogs() {
    const el = document.getElementById('freezerLogs');
    if (!el) return;

    const now = Date.now();
    const sorted = Object.entries(state.freezerLogs || {}).sort(([, a], [, b]) => {
        const ta = a.timestamp || new Date(a.dateAdded || 0).getTime();
        const tb = b.timestamp || new Date(b.dateAdded || 0).getTime();
        return tb - ta;
    });

    let html = '';
    sorted.forEach(([key, log]) => {
        const items = log.items || {};
        const remainingPairs = Object.entries(items).filter(([, v]) => Number(v) > 0);
        const totalRem = remainingPairs.reduce((s, [, v]) => s + Number(v), 0);

        // إخفاء السجلات المستهلكة بالكامل (FIFO) إلا في وضع إدارة الحذف
        if (totalRem === 0 && !state.ui.isDeleteLogMode) return;

        const daysOld = Math.max(0, Math.floor((now - new Date(log.dateAdded || now).getTime()) / 86400000));
        let ageBadge = '';
        if (totalRem === 0) {
            ageBadge = '<span class="badge" style="background:var(--text-secondary);">تم البيع بالكامل (FIFO)</span>';
        } else if (daysOld <= 7) {
            ageBadge = '<span class="badge" style="background:var(--success);">طازج</span>';
        } else if (daysOld < 30) {
            ageBadge = `<span class="badge" style="background:var(--warning);">منذ ${daysOld} يوم</span>`;
        } else {
            ageBadge = `<span class="badge" style="background:var(--danger);">⚠️ قديم (${daysOld} يوم)</span>`;
        }

        const itemsStr = remainingPairs.length > 0
            ? remainingPairs.map(([k, v]) => `${escapeHtml(state.freezerConfig[k]?.name || k)}: <b>${v}</b>`).join(' &nbsp;|&nbsp; ')
            : '<span class="sub-text">نفدت الكمية</span>';

        const delBtn = state.ui.isDeleteLogMode
            ? `<button class="btn btn-danger btn-sm" onclick="deleteFreezerLog('${key}')"><i class="fas fa-trash"></i></button>`
            : '';

        html += `
        <div class="freezer-log-item ${daysOld >= 30 && totalRem > 0 ? 'log-urgent' : ''}">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div><strong>${escapeHtml(log.batchName || 'دفعة')}</strong> ${ageBadge}</div>
                ${delBtn}
            </div>
            <div class="sub-text" style="margin:4px 0;">تاريخ التخزين: ${escapeHtml(log.dateAdded || '-')}</div>
            <div style="color:var(--primary); font-size:13px;">المتبقي: ${itemsStr}</div>
        </div>`;
    });

    el.innerHTML = html || '<div class="empty-state">لا توجد أرصدة مخزنة حالياً بالفريزر.</div>';
}
