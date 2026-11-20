// www/js/modules/reports.js
// تقارير ربحية الدفعات (Batch P&L)، معامل التحويل (FCR)، وتكلفة إنتاج الجوز الحقيقية

import { state, getBirdStandard, fmtMoney, fmtNum, round2 } from '../core/state.js';
import { computeBatchFinancials } from '../core/accounting.js';
import { switchPage } from '../core/ui.js';
import { escapeHtml } from '../core/validators.js';

export function populateReportSelector() {
    const sel = document.getElementById('reportBatchSelect');
    if (!sel) return;
    const prev = sel.value;

    let html = '<option value="">-- اختر الدفعة لتحليل ربحيتها (P&L) --</option>';

    const activeEntries = Object.entries(state.batches || {})
        .sort(([, a], [, b]) => (b.order || 0) - (a.order || 0));
    if (activeEntries.length > 0) {
        html += '<optgroup label="الدفعات النشطة والمكتملة">';
        activeEntries.forEach(([id, b]) => {
            const std = getBirdStandard(b.birdType || 'quail');
            const st = statusLabelAr(b.status);
            html += `<option value="${id}">${escapeHtml(b.name)} (${std.name} - ${st})</option>`;
        });
        html += '</optgroup>';
    }

    const archivedEntries = Object.entries(state.archivedBatches || {})
        .sort(([, a], [, b]) => new Date(b.archiveDate || 0) - new Date(a.archiveDate || 0));
    if (archivedEntries.length > 0) {
        html += '<optgroup label="أرشيف الدفعات المصفاة">';
        archivedEntries.forEach(([id, b]) => {
            const std = getBirdStandard(b.birdType || 'quail');
            html += `<option value="${id}">${escapeHtml(b.name)} (${std.name} - مؤرشفة)</option>`;
        });
        html += '</optgroup>';
    }

    sel.innerHTML = html;
    if (prev && (state.batches[prev] || state.archivedBatches[prev])) {
        sel.value = prev;
        generateBatchReport();
    } else {
        generateBatchReport();
    }

    renderFarmOverviewKPIs();
}

function statusLabelAr(status) {
    const map = {
        incubator: 'حضانة',
        hatcher: 'مفقس',
        rearing: 'تربية',
        slaughter: 'قيد الذبح',
        completed: 'مكتملة بالفريزر',
        archived: 'مصفاة ومؤرشفة'
    };
    return map[status] || status;
}

export function openBatchReportFor(batchId) {
    switchPage('reports');
    const sel = document.getElementById('reportBatchSelect');
    if (sel) {
        sel.value = batchId;
        generateBatchReport();
    }
}

function renderFarmOverviewKPIs() {
    const el = document.getElementById('farmKpiOverview');
    if (!el) return;

    const allList = [...Object.values(state.batches || {}), ...Object.values(state.archivedBatches || {})];
    const hatchedBatches = allList.filter((b) => Number(b.hatchRate) > 0);
    const avgHatch = hatchedBatches.length > 0
        ? (hatchedBatches.reduce((s, b) => s + Number(b.hatchRate), 0) / hatchedBatches.length).toFixed(1)
        : 0;

    const rearedBatches = allList.filter((b) => Number(b.hatchedChicks) > 0);
    const totalHatched = rearedBatches.reduce((s, b) => s + (Number(b.hatchedChicks) || 0), 0);
    const totalDead = rearedBatches.reduce((s, b) => s + (Number(b.totalDead) || 0), 0);
    const avgMort = totalHatched > 0 ? ((totalDead / totalHatched) * 100).toFixed(1) : 0;

    const completedCount = allList.filter((b) => b.status === 'completed' || b.status === 'archived').length;

    el.innerHTML = `
        <div class="grid-3">
            <div class="stat-box">متوسط نسبة الفقس<span class="num text-success">${avgHatch}%</span></div>
            <div class="stat-box">متوسط النافق العام<span class="num text-danger">${avgMort}%</span></div>
            <div class="stat-box">دورات مكتملة<span class="num text-primary">${fmtNum(completedCount)}</span></div>
        </div>
    `;
}

export function generateBatchReport() {
    const id = document.getElementById('reportBatchSelect')?.value;
    const container = document.getElementById('batchReportContainer');
    if (!container) return;

    if (!id) {
        container.innerHTML = '<div class="empty-state">اختر دفعة من القائمة أعلاه لعرض التقرير الفني والمالي المفصل (P&L).</div>';
        return;
    }

    const b = state.batches[id] || state.archivedBatches[id];
    if (!b) return;

    const std = getBirdStandard(b.birdType || 'quail');
    const fin = computeBatchFinancials(id, b);

    const initialEggs = Number(b.initialEggs) || 0;
    const hatched = Number(b.hatchedChicks) || 0;
    const dead = Number(b.totalDead) || 0;
    const alive = Math.max(0, hatched - dead);
    const totalFeedKg = round2(b.totalFeed || 0);
    const mortRate = hatched > 0 ? ((dead / hatched) * 100).toFixed(1) : '0.0';
    const hatchRate = b.hatchRate || (initialEggs > 0 && hatched > 0 ? ((hatched / initialEggs) * 100).toFixed(1) : 0);

    // حساب الإيراد المتوقع أو الفعلي
    let revenue = 0;
    let revenueLabel = 'الإيراد المتوقع';
    let yieldHtml = '';
    let finalBirdsForFcr = alive;
    let finalUnits = 0;

    if (b.status === 'archived' && b.finalRevenue !== undefined) {
        revenue = round2(b.finalRevenue);
        revenueLabel = 'إيراد التصفية الفعلي';
        finalUnits = b.slaughterYield || Math.floor(alive / 2);
    } else if (b.status === 'completed' && b.classifyData) {
        revenueLabel = 'القيمة البيعية للفريزر';
        finalUnits = Number(b.slaughterYield) || 0;
        finalBirdsForFcr = Number(b.slaughterProcessedBirds) || (finalUnits * 2);

        Object.entries(b.classifyData).forEach(([catId, qty]) => {
            if (qty > 0) {
                const cat = state.freezerConfig[catId];
                const price = Number(cat?.price) || 0;
                revenue += qty * price;
                yieldHtml += `<span class="badge" style="background:var(--primary); margin:3px;">${escapeHtml(cat?.name || catId)}: ${qty}</span>`;
            }
        });
        revenue = round2(revenue);
    }

    const feedPerBirdGrams = finalBirdsForFcr > 0 ? Math.round((totalFeedKg * 1000) / finalBirdsForFcr) : 0;
    const estMeatKg = finalUnits > 0 ? round2(finalUnits * (std.avgPairWeightKg || 0.45)) : 0;
    const fcrRatio = estMeatKg > 0 ? (totalFeedKg / estMeatKg).toFixed(2) : '-';

    let fcrRating = '<span class="badge" style="background:var(--info);">قيد التقييم</span>';
    if (feedPerBirdGrams > 0 && (b.birdType || 'quail') === 'quail') {
        if (feedPerBirdGrams <= 460) fcrRating = '<span class="badge" style="background:var(--success);">ممتاز 🌟</span>';
        else if (feedPerBirdGrams <= 560) fcrRating = '<span class="badge" style="background:var(--warning);">متوسط ⚠️</span>';
        else fcrRating = '<span class="badge" style="background:var(--danger);">مرتفع (هدر علف) ❌</span>';
    }

    const costPerUnit = finalUnits > 0 ? round2(fin.totalCost / finalUnits) : (alive > 0 ? round2((fin.totalCost / alive) * 2) : 0);
    const netProfit = round2(revenue - fin.totalCost);
    const maxBar = Math.max(revenue, fin.totalCost, 1);
    const costBarW = Math.round((fin.totalCost / maxBar) * 100);
    const revBarW = Math.round((revenue / maxBar) * 100);

    const isFinalized = b.status === 'completed' || b.status === 'archived';

    container.innerHTML = `
        <div class="report-sheet">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:12px; margin-bottom:16px;">
                <div>
                    <h3 style="margin:0;">${std.icon} ${escapeHtml(b.name)}</h3>
                    <span class="sub-text">${std.name} • الحالة: <b>${statusLabelAr(b.status)}</b></span>
                </div>
                ${state.batches[id] && b.status === 'completed' ? `<button class="btn btn-warning btn-sm" onclick="promptDirectLiquidation('${id}')"><i class="fas fa-box-archive"></i> أرشفة</button>` : ''}
            </div>

            <div class="grid-4" style="margin-bottom:16px;">
                <div class="mini-kpi"><span>🥚 البيض</span><strong>${fmtNum(initialEggs)}</strong></div>
                <div class="mini-kpi"><span>🐣 الفقس</span><strong class="text-success">${hatchRate}%</strong></div>
                <div class="mini-kpi"><span>☠️ النافق</span><strong class="text-danger">${fmtNum(dead)} (${mortRate}%)</strong></div>
                <div class="mini-kpi"><span>🌾 العلف</span><strong>${fmtNum(totalFeedKg, 1)} كجم</strong></div>
            </div>

            <div class="info-box" style="margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                    <div>
                        <span class="sub-text">كفاءة التحويل والاستهلاك (FCR):</span><br>
                        <strong style="font-size:18px; color:var(--primary);">${fmtNum(feedPerBirdGrams)} جرام/طائر</strong>
                        ${fcrRatio !== '-' ? `<span class="sub-text"> | معامل تحويل تقديري: <b>${fcrRatio}</b></span>` : ''}
                    </div>
                    ${fcrRating}
                </div>
            </div>

            <div class="cost-breakdown" style="margin-bottom:16px;">
                <h4 style="margin:0 0 10px 0;">تفصيل التكاليف الحقيقية للدورة</h4>
                <div class="breakdown-row"><span>🐣 تكلفة الكتاكيت المحولة</span><strong>${fmtMoney(fin.chickCost)} ج.م</strong></div>
                <div class="breakdown-row"><span>🌾 تكلفة العلف المستهلك ${fin.estimatedFeedFallback ? '(تقديري)' : '(بالسعر المرجح)'}</span><strong>${fmtMoney(fin.feedCost)} ج.م</strong></div>
                <div class="breakdown-row"><span>💉 مصاريف مباشرة محمّلة (أدوية/تدفئة/عمالة)</span><strong>${fmtMoney(fin.directExpenses)} ج.م</strong></div>
                <div class="breakdown-row total-row"><span>إجمالي تكلفة الدورة</span><strong class="text-danger">${fmtMoney(fin.totalCost)} ج.م</strong></div>
            </div>

            ${yieldHtml ? `<div style="margin-bottom:16px;"><div class="sub-text" style="margin-bottom:6px;">مخرجات الدفعة بالفريزر (${fmtNum(finalUnits)} وحدة${b.slaughterLoss ? ` | هالك ذبح: ${b.slaughterLoss} طائر` : ''}):</div>${yieldHtml}</div>` : ''}

            <div class="info-box" style="text-align:center; margin-bottom:16px; border:1px solid var(--primary);">
                <span class="sub-text">متوسط تكلفة إنتاج <b>الجوز/الوحدة</b> حتى الآن</span>
                <div style="font-size:26px; font-weight:800; color:var(--primary);">${fmtMoney(costPerUnit)} ج.م</div>
            </div>

            ${isFinalized ? `
                <div class="visual-bars" style="margin-bottom:16px;">
                    <div class="bar-label"><span>التكلفة الإجمالية</span><b class="text-danger">${fmtMoney(fin.totalCost)} ج</b></div>
                    <div class="bar-track"><div class="bar-fill" style="width:${costBarW}%; background:var(--danger);"></div></div>
                    <div class="bar-label" style="margin-top:10px;"><span>${revenueLabel}</span><b class="text-success">${fmtMoney(revenue)} ج</b></div>
                    <div class="bar-track"><div class="bar-fill" style="width:${revBarW}%; background:var(--success);"></div></div>
                </div>
                <div class="result-stamp" style="color:${netProfit >= 0 ? 'var(--success)' : 'var(--danger)'}; border-color:${netProfit >= 0 ? 'var(--success)' : 'var(--danger)'};">
                    ${netProfit > 0 ? `✅ صافي ربح الدورة: +${fmtMoney(netProfit)} ج.م` : (netProfit < 0 ? `❌ صافي خسارة الدورة: ${fmtMoney(netProfit)} ج.م` : '➖ تعادل (لا ربح ولا خسارة)')}
                </div>
            ` : `
                <div class="alert-box alert-warning">
                    ⏳ الدفعة لا تزال قيد التشغيل. الأرقام أعلاه تعكس التكلفة الحقيقية التراكمية حتى اللحظة، ويظهر صافي الربح النهائي فور التصنيف أو التصفية.
                </div>
            `}
        </div>
    `;
}
