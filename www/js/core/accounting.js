// www/js/core/accounting.js
// المحرك المحاسبي الدقيق: فصل الكاش عن تكلفة الدورات + متوسط سعر العلف المرجّح (WAC) + عكس الحذف بدقة

import { db, ref, push, set, get, update, remove, atomicAdjust } from '../config/firebase.js';
import { state, getEffectiveFeedPrice, round2, todayISO } from './state.js';

/**
 * تسجيل حركة مالية نقدية (إيراد in أو مصروف out)
 * تُحدّث: دفتر الحركات (ledger) + عدادات الشهر (financialCenter) + الخزنة (cashBox)
 */
export async function recordCashTransaction({
    type,
    amount,
    desc,
    batchId = 'general',
    category = 'general',
    extra = {}
}) {
    const cleanAmount = round2(amount);
    if (cleanAmount <= 0) throw new Error('INVALID_AMOUNT');

    const entry = {
        type, // 'in' | 'out'
        amount: cleanAmount,
        desc,
        batchId: batchId || 'general',
        category,
        date: todayISO(),
        timestamp: Date.now(),
        ...extra
    };

    const newRef = await push(ref(db, 'ledger'), entry);

    if (type === 'in') {
        await atomicAdjust('financialCenter/currentMonthRevenue', cleanAmount, { allowNegative: true });
        await atomicAdjust('cashBox', cleanAmount, { allowNegative: true });
    } else if (type === 'out') {
        await atomicAdjust('financialCenter/currentMonthExpenses', cleanAmount, { allowNegative: true });
        await atomicAdjust('cashBox', -cleanAmount, { allowNegative: true });
    }

    return newRef.key;
}

/**
 * تسجيل تكلفة داخلية محمّلة على دفعة (علف مستهلك من المخزن أو قيمة كتاكيت محولة)
 * لا تلمس مصروفات الشهر ولا الكاش (لأن النقدية خرجت مسبقاً عند الشراء) -> تمنع الازدواجية المحاسبية 100%
 */
export async function recordBatchCost({
    amount,
    desc,
    batchId,
    costSource, // 'feed' | 'breeder_feed' | 'chicks'
    feedQty = 0,
    unitCost = 0,
    chicksQty = 0
}) {
    const cleanAmount = round2(amount);
    if (cleanAmount <= 0) return null;

    const entry = {
        type: 'batch_cost',
        costSource,
        amount: cleanAmount,
        desc,
        batchId,
        feedQty: round2(feedQty),
        unitCost: round2(unitCost),
        chicksQty: Math.floor(chicksQty || 0),
        date: todayISO(),
        timestamp: Date.now()
    };

    const newRef = await push(ref(db, 'ledger'), entry);
    return newRef.key;
}

/**
 * شراء علف للمخزن مع حساب متوسط التكلفة المرجّح (Weighted Average Cost)
 */
export async function purchaseFeedStock(qtyKg, totalCost) {
    const qty = round2(qtyKg);
    const cost = round2(totalCost);
    const unitCost = round2(cost / qty);

    const oldQty = Math.max(0, parseFloat((await get(ref(db, 'inventory/feedStock'))).val()) || 0);
    const oldAvg = getEffectiveFeedPrice();
    const newTotalQty = oldQty + qty;
    const weightedAvg = newTotalQty > 0 ? round2(((oldQty * oldAvg) + cost) / newTotalQty) : unitCost;

    await atomicAdjust('inventory/feedStock', qty, { allowNegative: false, decimals: 2 });
    await set(ref(db, 'inventory/feedAvgCost'), weightedAvg);

    await recordCashTransaction({
        type: 'out',
        amount: cost,
        desc: `شراء علف (${qty} كجم × ${unitCost} ج)`,
        batchId: 'general',
        category: 'feed_purchase',
        extra: { feedQty: qty, unitCost }
    });

    return { newTotalQty: round2(newTotalQty), weightedAvg, unitCost };
}

/**
 * سحب علف من المخزن لدفعة تربية أو قطيع أمهات بمتوسط السعر الفعلي
 */
export async function consumeFeedFromStock({ qtyKg, batchId, desc }) {
    const qty = round2(qtyKg);
    const unitPrice = getEffectiveFeedPrice();
    const feedCost = round2(qty * unitPrice);

    // خصم ذري يفشل بأمان إذا كان المخزون لا يكفي
    await atomicAdjust('inventory/feedStock', -qty, { allowNegative: false, decimals: 2 });

    await recordBatchCost({
        amount: feedCost,
        desc: desc || `سحب علف (${qty} كجم × ${unitPrice} ج)`,
        batchId,
        costSource: batchId === 'breeders' ? 'breeder_feed' : 'feed',
        feedQty: qty,
        unitCost: unitPrice
    });

    return { feedCost, unitPrice };
}

/**
 * حذف معاملة مالية مع عكس أثرها المحاسبي والمخزني بالكامل (إصلاح الخطأ التاريخي)
 */
export async function reverseAndDeleteTransaction(txId) {
    const tx = state.ledger[txId];
    if (!tx) return { reversed: false };

    const amount = round2(tx.amount || 0);

    if (tx.type === 'in') {
        await atomicAdjust('financialCenter/currentMonthRevenue', -amount, { allowNegative: true });
        await atomicAdjust('cashBox', -amount, { allowNegative: true });
    } else if (tx.type === 'out') {
        await atomicAdjust('financialCenter/currentMonthExpenses', -amount, { allowNegative: true });
        await atomicAdjust('cashBox', amount, { allowNegative: true });
    } else if (tx.type === 'batch_cost') {
        // نُعيد العلف للمخزن فقط لو كانت المعاملة فعلاً سحب علف (مش تكلفة كتاكيت!)
        const isFeedSource = tx.costSource === 'feed' || tx.costSource === 'breeder_feed' || (!tx.costSource && (tx.desc || '').includes('علف'));
        if (isFeedSource) {
            const qtyToRestore = tx.feedQty > 0
                ? round2(tx.feedQty)
                : round2(amount / (tx.unitCost || getEffectiveFeedPrice()));
            if (qtyToRestore > 0) {
                await atomicAdjust('inventory/feedStock', qtyToRestore, { allowNegative: false, decimals: 2 });
                if (tx.batchId && tx.batchId !== 'general' && tx.batchId !== 'breeders' && state.batches[tx.batchId]) {
                    await atomicAdjust(`batches/${tx.batchId}/totalFeed`, -qtyToRestore, { allowNegative: false, decimals: 2 }).catch(() => {});
                }
            }
        }
    }

    await remove(ref(db, `ledger/${txId}`));
    return { reversed: true, tx };
}

/**
 * تقفيل الشهر الحالي: ترحيل الصافي للرصيد التراكمي + أرشفة الدفتر + حفظ ملخص الشهر
 */
export async function closeCurrentMonth() {
    const rev = round2(state.financialCenter.currentMonthRevenue || 0);
    const exp = round2(state.financialCenter.currentMonthExpenses || 0);
    const netProfit = round2(rev - exp);
    const newCumulative = round2((state.financialCenter.cumulativeBalance || 0) + netProfit);

    const now = new Date();
    const monthLabel = now.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long' });

    // 1. حفظ سجل تاريخي لتقفيل هذا الشهر
    await push(ref(db, 'monthlyClosings'), {
        monthLabel,
        closedDate: todayISO(),
        revenue: rev,
        expenses: exp,
        netProfit,
        resultingBalance: newCumulative,
        timestamp: Date.now()
    });

    // 2. ترحيل للرصيد التراكمي وتصفير عدادات الشهر
    await update(ref(db, 'financialCenter'), {
        cumulativeBalance: newCumulative,
        currentMonthRevenue: 0,
        currentMonthExpenses: 0
    });

    // 3. أرشفة الحركات الحالية بدون مسح الأرشيف القديم
    const ledgerSnap = await get(ref(db, 'ledger'));
    if (ledgerSnap.exists()) {
        const currentLedger = ledgerSnap.val();
        await update(ref(db, 'archivedLedger'), currentLedger);
        await remove(ref(db, 'ledger'));
    }

    return { rev, exp, netProfit, newCumulative };
}

/**
 * حساب إجمالي التكلفة الحقيقية لدفعة معينة (من الدفتر الحالي + المؤرشف)
 */
export function computeBatchFinancials(batchId, batch) {
    let chickCost = 0;
    let feedCost = 0;
    let directExpenses = 0;

    const scanLedger = (ledgerObj) => {
        if (!ledgerObj) return;
        Object.values(ledgerObj).forEach((t) => {
            if (t.batchId !== batchId) return;
            const amt = Number(t.amount) || 0;
            if (t.type === 'out') {
                directExpenses += amt;
            } else if (t.type === 'batch_cost') {
                if (t.costSource === 'chicks' || (t.desc || '').includes('كتاكيت')) {
                    chickCost += amt;
                } else {
                    feedCost += amt;
                }
            }
        });
    };

    scanLedger(state.ledger);
    scanLedger(state.archivedLedger);

    // لو دفعة قديمة استهلكت علف قبل وجود قيود batch_cost في الدفتر، نحسب تقديرها كاحتياط
    const totalFeedKg = Number(batch?.totalFeed) || 0;
    let estimatedFeedFallback = false;
    if (feedCost === 0 && totalFeedKg > 0) {
        feedCost = round2(totalFeedKg * getEffectiveFeedPrice());
        estimatedFeedFallback = true;
    }

    const totalCost = round2(chickCost + feedCost + directExpenses);
    return {
        chickCost: round2(chickCost),
        feedCost: round2(feedCost),
        directExpenses: round2(directExpenses),
        totalCost,
        estimatedFeedFallback
    };
}
