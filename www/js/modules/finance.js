// www/js/modules/finance.js
// المركز المالي الموحد، المصروفات، شراء العلف، تصفية الدفعات المباشرة، والأرشفة والتقفيل الشهري

import { db, ref, set, remove, syncBatchToCRM } from '../config/firebase.js';
import { state, fmtMoney, fmtNum, getEffectiveFeedPrice, todayISO, round2 } from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, parseRequiredText, escapeHtml } from '../core/validators.js';
import {
    recordCashTransaction,
    purchaseFeedStock,
    reverseAndDeleteTransaction,
    closeCurrentMonth
} from '../core/accounting.js';
import { clearShelvesForBatch } from './incubator.js';

export function renderFinanceSummary() {
    const cumBal = round2(state.financialCenter.cumulativeBalance || 0);
    const rev = round2(state.financialCenter.currentMonthRevenue || 0);
    const exp = round2(state.financialCenter.currentMonthExpenses || 0);
    const liveMonthNet = round2(rev - exp);
    const cash = round2(state.cashBox || 0);

    // 1. تحديث مربع الرصيد الحر في لوحة القيادة (إصلاح الخلل السابق!)
    const dashBal = document.getElementById('dashCumulativeBalance');
    if (dashBal) {
        dashBal.textContent = fmtMoney(cumBal);
        dashBal.style.color = cumBal < 0 ? 'var(--danger)' : 'var(--primary)';
    }

    const dashMonthNet = document.getElementById('dashMonthNet');
    if (dashMonthNet) {
        dashMonthNet.textContent = `${liveMonthNet >= 0 ? '+' : ''}${fmtMoney(liveMonthNet)}`;
        dashMonthNet.style.color = liveMonthNet >= 0 ? 'var(--success)' : 'var(--danger)';
    }

    // 2. تحديث صفحة الماليات
    const balEl = document.getElementById('cumulativeBalanceDisplay');
    if (balEl) {
        balEl.textContent = `${fmtMoney(cumBal)} ج.م`;
        balEl.style.color = cumBal < 0 ? '#fecaca' : '#ffffff';
    }
    const revEl = document.getElementById('currentMonthRevenue');
    if (revEl) revEl.textContent = `${fmtMoney(rev)} ج.م`;
    const expEl = document.getElementById('currentMonthExpenses');
    if (expEl) expEl.textContent = `${fmtMoney(exp)} ج.م`;

    const netEl = document.getElementById('currentMonthNet');
    if (netEl) {
        netEl.textContent = `${liveMonthNet >= 0 ? '+' : ''}${fmtMoney(liveMonthNet)} ج.م`;
        netEl.style.color = liveMonthNet >= 0 ? 'var(--success)' : 'var(--danger)';
    }

    const cashEl = document.getElementById('cashBoxDisplay');
    if (cashEl) cashEl.textContent = `${fmtMoney(cash)} ج.م`;
}

export function renderFeedStockCard() {
    const feedEl = document.getElementById('feedStockDisplay');
    const avgEl = document.getElementById('feedAvgCostDisplay');
    const avgPrice = getEffectiveFeedPrice();
    if (feedEl) {
        feedEl.innerHTML = `
            <span class="editable-stat" onclick="editFeedStock()" title="اضغط للتعديل اليدوي">
                ${fmtNum(state.feedStock, 2)} <small style="font-size:15px;">كجم</small>
                <i class="fas fa-pen" style="font-size:12px; margin-right:6px; opacity:0.7;"></i>
            </span>`;
    }
    if (avgEl) {
        avgEl.textContent = `متوسط تكلفة الكيلو الفعلي: ${fmtMoney(avgPrice)} ج.م`;
    }
}

export async function editFeedStock() {
    const raw = prompt('تعديل رصيد العلف بالمخزن يدوياً (بالكجم):', state.feedStock);
    if (raw === null) return;
    const val = parsePositiveNumber(raw, 'رصيد العلف', { allowZero: true });
    if (val === null) return;
    await set(ref(db, 'inventory/feedStock'), round2(val));
    showToast('تم تحديث رصيد العلف بنجاح 🌾');
}

export async function editCashBox() {
    const raw = prompt('تعديل رصيد الخزنة النقدية الفعلي (ج.م):', state.cashBox);
    if (raw === null) return;
    const val = parseFloat(raw);
    if (isNaN(val)) return showToast('أدخل رقماً صحيحاً', true);
    await set(ref(db, 'cashBox'), round2(val));
    showToast('تم تحديث رصيد الخزنة بنجاح 💵');
}

export function openBuyFeedModal() {
    const q = document.getElementById('bfQty');
    const c = document.getElementById('bfTotalCost');
    const u = document.getElementById('bfUnitPreview');
    if (q) q.value = '';
    if (c) c.value = '';
    if (u) u.textContent = '';
    openModal('modalBuyFeed');
}

export function previewFeedUnitCost() {
    const qty = parseFloat(document.getElementById('bfQty')?.value) || 0;
    const cost = parseFloat(document.getElementById('bfTotalCost')?.value) || 0;
    const el = document.getElementById('bfUnitPreview');
    if (!el) return;
    if (qty > 0 && cost > 0) {
        el.textContent = `سعر الكيلو في هذه الفاتورة: ${fmtMoney(round2(cost / qty))} ج.م`;
    } else {
        el.textContent = '';
    }
}

export async function buyFeed() {
    await withActionLock('buyFeed', async () => {
        const qty = parsePositiveNumber(document.getElementById('bfQty')?.value, 'كمية العلف (كجم)');
        const cost = parsePositiveNumber(document.getElementById('bfTotalCost')?.value, 'التكلفة الإجمالية');
        if (qty === null || cost === null) return;

        const res = await purchaseFeedStock(qty, cost);
        closeModal('modalBuyFeed');
        showToast(`تم توريد ${qty} كجم | متوسط الكيلو الجديد: ${fmtMoney(res.weightedAvg)} ج 🌾`);
    }, 'جاري توريد العلف وتحديث المتوسط...');
}

export function openExpenseModal() {
    const a = document.getElementById('eAmount');
    const t = document.getElementById('eType');
    const b = document.getElementById('eBatch');
    const mode = document.getElementById('eTxType');
    if (a) a.value = '';
    if (t) t.value = '';
    if (b) b.value = 'general';
    if (mode) mode.value = 'out';
    openModal('modalExpense');
}

export async function saveManualTransaction() {
    await withActionLock('manualTx', async () => {
        const txType = document.getElementById('eTxType')?.value || 'out';
        const amount = parsePositiveNumber(document.getElementById('eAmount')?.value, 'المبلغ');
        const desc = parseRequiredText(document.getElementById('eType')?.value, 'البيان / البند');
        const batchId = txType === 'out' ? (document.getElementById('eBatch')?.value || 'general') : 'general';

        if (amount === null || !desc) return;

        await recordCashTransaction({
            type: txType,
            amount,
            desc,
            batchId,
            category: txType === 'in' ? 'other_income' : (batchId === 'general' ? 'general_expense' : 'batch_direct_expense')
        });

        closeModal('modalExpense');
        showToast(txType === 'in' ? 'تم تسجيل الإيراد بنجاح 💰' : 'تم تسجيل المصروف بنجاح 💸');
    }, 'جاري تسجيل الحركة المالية...');
}

export async function deleteTransaction(txId) {
    const tx = state.ledger[txId];
    if (!tx) return;
    if (!confirm(`هل أنت متأكد من حذف هذه الحركة وعكس أثرها المحاسبي بالكامل؟
"${tx.desc}" (${fmtMoney(tx.amount)} ج.م)`)) {
        return;
    }

    await withActionLock(`delTx_${txId}`, async () => {
        await reverseAndDeleteTransaction(txId);
        showToast('تم الحذف وعكس الأثر المالي/المخزني بدقة ✅');
    }, 'جاري عكس الحركة المالية...');
}

export function renderTransactionsList() {
    const lList = document.getElementById('ledgerList');
    if (!lList) return;

    let arr = Object.entries(state.ledger || {})
        .map(([id, t]) => ({ id, ...t }))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const q = (state.ui.ledgerSearch || '').trim().toLowerCase();
    if (q) {
        arr = arr.filter((t) => (t.desc || '').toLowerCase().includes(q) || (t.date || '').includes(q));
    }
    if (state.ui.ledgerFilter !== 'all') {
        arr = arr.filter((t) => t.type === state.ui.ledgerFilter);
    }

    const totalFound = arr.length;
    const limit = 60;
    const shown = arr.slice(0, limit);

    if (shown.length === 0) {
        lList.innerHTML = '<div class="empty-state">لا توجد حركات مالية مطابقة في الشهر الحالي.</div>';
        return;
    }

    let html = shown.map((t) => {
        const isIn = t.type === 'in';
        const isOut = t.type === 'out';
        const color = isIn ? 'var(--success)' : (isOut ? 'var(--danger)' : 'var(--warning)');
        const sign = isIn ? '+' : '-';
        const tag = t.type === 'batch_cost'
            ? '<span class="pill-tag pill-warn">تكلفة داخلية (عيني)</span>'
            : (t.batchId && t.batchId !== 'general'
                ? `<span class="pill-tag pill-info">محمّل على دفعة</span>`
                : '');

        return `
        <div class="transaction-item" style="border-right:4px solid ${color};">
            <div style="flex:1; min-width:0;">
                <div style="font-weight:700; word-break:break-word;">${escapeHtml(t.desc || '-')} ${tag}</div>
                <div class="sub-text">${escapeHtml(t.date || '')}</div>
            </div>
            <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
                <strong style="color:${color}; font-size:15px;" dir="ltr">${sign} ${fmtMoney(t.amount)} ج</strong>
                <button class="icon-btn-danger" onclick="deleteTransaction('${t.id}')" title="حذف وعكس الأثر"><i class="fas fa-trash-alt"></i></button>
            </div>
        </div>`;
    }).join('');

    if (totalFound > limit) {
        html += `<div class="sub-text" style="text-align:center; padding:10px;">يتم عرض أحدث ${limit} حركة من أصل ${totalFound}. استخدم البحث أو الفلتر لعرض الأقدم.</div>`;
    }

    lList.innerHTML = html;
}

export function filterLedger(type) {
    state.ui.ledgerFilter = type;
    renderTransactionsList();
}

export function searchLedger(query) {
    state.ui.ledgerSearch = query;
    renderTransactionsList();
}

// ================= التصفية المباشرة للدفعات (بيع جملة/صاحي/كتاكيت بدون فريزر) =================
export function promptDirectLiquidation(id) {
    const b = state.batches[id];
    if (!b) return;
    document.getElementById('archiveBatchId').value = id;
    document.getElementById('archiveBatchNameDisplay').textContent = b.name || '';
    document.getElementById('archiveRevenue').value = '';
    document.getElementById('archiveNote').value = b.status === 'incubator' || b.status === 'hatcher'
        ? 'بيع مباشر للكتاكيت / البيض'
        : 'بيع مباشر / تصفية خارج الفريزر';
    openModal('modalArchiveBatch');
}

export async function confirmArchiveBatch() {
    await withActionLock('archiveBatch', async () => {
        const id = document.getElementById('archiveBatchId')?.value;
        const b = state.batches[id];
        if (!b) return;

        const revenue = parsePositiveNumber(document.getElementById('archiveRevenue')?.value, 'إجمالي الإيراد', { allowZero: true });
        if (revenue === null) return;
        const note = (document.getElementById('archiveNote')?.value || '').trim();

        // لو الدفعة كانت اتصنفت فعلاً للفريزر (completed)، ممنوع نضيف إيراد مكرر!
        if (b.status === 'completed' && revenue > 0) {
            const proceed = confirm('⚠️ تنبيه محاسبي: هذه الدفعة سبق ترحيل بضاعتها للفريزر! إذا كنت ستبيع من الفريزر لاحقاً، فإدخال إيراد هنا سيسبب ازدواجية. هل أنت متأكد من المتابعة؟');
            if (!proceed) return;
        }

        if (revenue > 0) {
            await recordCashTransaction({
                type: 'in',
                amount: revenue,
                desc: `تصفية مباشرة: ${b.name}${note ? ' (' + note + ')' : ''}`,
                batchId: id,
                category: 'direct_batch_sale'
            });
        }

        const archivedObj = {
            ...b,
            status: 'archived',
            finalRevenue: revenue,
            archiveDate: todayISO(),
            note
        };

        await set(ref(db, `archivedBatches/${id}`), archivedObj);
        await clearShelvesForBatch(id);
        await remove(ref(db, `batches/${id}`));

        try {
            await syncBatchToCRM(id, { isOpen: false, isVisible: false }, false);
        } catch (err) {
            console.warn('CRM archive patch skipped:', err);
        }

        closeModal('modalArchiveBatch');
        showToast('تمت التصفية والأرشفة وترحيل الإيراد بدقة 📦');
    }, 'جاري التصفية والأرشفة...');
}

export function renderArchivedBatches() {
    const list = document.getElementById('archivedBatchesList');
    if (!list) return;

    const entries = Object.entries(state.archivedBatches || {})
        .sort(([, a], [, b]) => new Date(b.archiveDate || 0) - new Date(a.archiveDate || 0));

    if (entries.length === 0) {
        list.innerHTML = '<div class="empty-state">لا توجد دفعات مصفاة في الأرشيف حتى الآن.</div>';
        return;
    }

    list.innerHTML = entries.map(([id, b]) => `
        <div class="mini-log-row" style="border-right:4px solid var(--success); padding-right:12px;">
            <div>
                <strong>${escapeHtml(b.name || 'دفعة')}</strong>
                <div class="sub-text">تاريخ الأرشفة: ${escapeHtml(b.archiveDate || '-')} ${b.note ? '• ' + escapeHtml(b.note) : ''}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="text-align:left;">
                    <span class="sub-text" style="font-size:11px;">إيراد التصفية</span>
                    <div class="text-success" style="font-weight:800;">${fmtMoney(b.finalRevenue || 0)} ج.م</div>
                </div>
                <button class="btn btn-info btn-sm" onclick="openBatchReportFor('${id}')" title="تقرير الربحية P&L"><i class="fas fa-chart-bar"></i></button>
            </div>
        </div>
    `).join('');
}

export function renderMonthlyClosingsHistory() {
    const el = document.getElementById('monthlyClosingsList');
    if (!el) return;

    const entries = Object.values(state.monthlyClosings || {})
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (entries.length === 0) {
        el.innerHTML = '<div class="empty-state">لم يتم تقفيل أي شهر بعد.</div>';
        return;
    }

    el.innerHTML = entries.map((m) => `
        <div class="mini-log-row">
            <div>
                <strong>${escapeHtml(m.monthLabel || m.closedDate)}</strong>
                <div class="sub-text">إيراد: <b class="text-success">${fmtMoney(m.revenue)}</b> | مصروف: <b class="text-danger">${fmtMoney(m.expenses)}</b></div>
            </div>
            <div style="text-align:left;">
                <strong style="color:${m.netProfit >= 0 ? 'var(--success)' : 'var(--danger)'};" dir="ltr">
                    ${m.netProfit >= 0 ? '+' : ''}${fmtMoney(m.netProfit)} ج
                </strong>
                <div class="sub-text" style="font-size:11px;">الرصيد بعدها: ${fmtMoney(m.resultingBalance)} ج</div>
            </div>
        </div>
    `).join('');
}

export async function closeMonth() {
    const rev = round2(state.financialCenter.currentMonthRevenue || 0);
    const exp = round2(state.financialCenter.currentMonthExpenses || 0);
    const net = round2(rev - exp);

    const msg = `هل أنت متأكد من تقفيل الشهر الحالي؟

` +
        `• الإيرادات: ${fmtMoney(rev)} ج.م
` +
        `• المصروفات: ${fmtMoney(exp)} ج.م
` +
        `• صافي الشهر: ${net >= 0 ? '+' : ''}${fmtMoney(net)} ج.م

` +
        `سيتم ترحيل الصافي للرصيد التراكمي وأرشفة حركات الشهر وتصفير العدادات.`;

    if (!confirm(msg)) return;

    await withActionLock('closeMonth', async () => {
        const res = await closeCurrentMonth();
        showToast(
            res.netProfit >= 0
                ? `تم تقفيل الشهر بنجاح! أرباح +${fmtMoney(res.netProfit)} ج.م 💰`
                : `تم تقفيل الشهر! عجز ${fmtMoney(Math.abs(res.netProfit))} ج.م 📉`
        );
    }, 'جاري تقفيل الشهر وأرشفة الدفتر...');
}
