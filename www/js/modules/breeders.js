// www/js/modules/breeders.js
// نظام إدارة أمهات السمان المتكامل (تعدد القطعان/البطاريات + تحكم حر كامل + تحليلات وتكلفة البيضة + عكس السجلات)

import { db, ref, set, push, update, remove, atomicAdjust } from '../config/firebase.js';
import { state, getTrueFlockAgeWeeks, fmtMoney, fmtNum, todayISO, round2 } from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, parseRequiredText, escapeHtml } from '../core/validators.js';
import { recordCashTransaction, consumeFeedFromStock } from '../core/accounting.js';

let activeBreederLogTab = 'triage';

function getFlocksList() {
    const flocksObj = state.breedersFlocks || {};
    const entries = Object.entries(flocksObj).map(([id, f]) => ({ id, ...f }));
    if (entries.length > 0) {
        return entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    const legF = Number(state.flockData?.females) || 0;
    const legM = Number(state.flockData?.males) || 0;
    if (legF > 0 || legM > 0) {
        return [{
            id: 'legacy_main',
            name: 'القطيع الأساسي',
            location: 'العنبر الرئيسي',
            breed: 'سمان ياباني / هجين',
            females: legF,
            males: legM,
            entryDate: state.flockData.entryDate || todayISO(),
            initialAgeWeeks: Number(state.flockData.initialAgeWeeks) || 0,
            notes: '',
            isLegacy: true
        }];
    }
    return [];
}

function calcFlockAgeWeeks(flock) {
    const initAge = Number(flock.initialAgeWeeks) || 0;
    if (!flock.entryDate) return initAge;
    const d = new Date(flock.entryDate);
    if (isNaN(d.getTime())) return initAge;
    const weeks = Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 7)));
    return initAge + weeks;
}

function getFlockStageMeta(ageWeeks) {
    if (ageWeeks < 6) return { label: 'تحضير (إحلال)', color: 'var(--info)', productive: false };
    if (ageWeeks <= 8) return { label: 'بشاير إنتاج', color: 'var(--purple)', productive: true };
    if (ageWeeks <= 24) return { label: 'ذروة الإنتاج 🌟', color: 'var(--success)', productive: true };
    if (ageWeeks <= 28) return { label: 'انحدار - جهّز إحلال', color: 'var(--warning)', productive: true };
    return { label: 'مطلوب إحلال/استبعاد ⚠️', color: 'var(--danger)', productive: true };
}

function getRatioAnalysis(females, males, ageWeeks) {
    if (females <= 0 && males <= 0) {
        return { pct: 0, ratioText: '-', status: 'فارغ', color: 'var(--text-secondary)', advice: 'أضف قطيع أمهات للبدء.' };
    }
    if (females === 0) {
        return { pct: 0, ratioText: 'ذكور فقط', status: 'بدون إناث', color: 'var(--danger)', advice: 'لا توجد إناث بياضة.' };
    }
    const ratio = males / females;
    const femalesPerMale = males > 0 ? (females / males).toFixed(1) : '∞';
    const idealMales = Math.round(females / 3);
    const diffMales = idealMales - males;
    const agePenalty = ageWeeks > 28 ? 12 : (ageWeeks > 24 ? 5 : 0);

    if (ratio >= 0.30 && ratio <= 0.48) {
        const pct = Math.max(60, 92 - agePenalty);
        return {
            pct,
            ratioText: `1 : ${femalesPerMale}`,
            status: 'تلقيح مثالي ✅',
            color: 'var(--success)',
            advice: 'النسبة الجنسية مثالية لإخصاب مرتفع.'
        };
    }
    if (ratio > 0.48) {
        const extra = Math.max(1, males - Math.round(females * 0.4));
        const pct = Math.max(55, 80 - agePenalty);
        return {
            pct,
            ratioText: `1 : ${femalesPerMale}`,
            status: 'تكدس ذكور ⚠️',
            color: 'var(--warning)',
            advice: `يوجد ~${extra} ذكر زائد — استبعادهم يرفع الهدوء ويوفر ${(extra * 0.033).toFixed(1)} كجم علف/يوم.`
        };
    }
    if (ratio >= 0.20) {
        const pct = Math.max(50, 74 - agePenalty);
        return {
            pct,
            ratioText: `1 : ${femalesPerMale}`,
            status: 'نقص ذكور ⚠️',
            color: 'var(--warning)',
            advice: `تحتاج إضافة ~${Math.max(1, diffMales)} ذكر للوصول للنسبة المثالية (1:3).`
        };
    }
    return {
        pct: 48,
        ratioText: `1 : ${femalesPerMale}`,
        status: 'خطر إخصاب منخفض 🚨',
        color: 'var(--danger)',
        advice: `عجز حاد في الذكور! أضف ${Math.max(1, diffMales)} ذكر فوراً.`
    };
}

async function syncTotalsToLegacyFlockData(flocksObjOverride = null) {
    const obj = flocksObjOverride !== null ? flocksObjOverride : (state.breedersFlocks || {});
    const list = Object.values(obj);
    let totalF = 0;
    let totalM = 0;
    let oldestEntry = '';
    let maxInitAge = 0;

    list.forEach((f) => {
        totalF += Number(f.females) || 0;
        totalM += Number(f.males) || 0;
        if (f.entryDate && (!oldestEntry || f.entryDate < oldestEntry)) {
            oldestEntry = f.entryDate;
            maxInitAge = Number(f.initialAgeWeeks) || 0;
        }
    });

    await set(ref(db, 'inventory/flockData'), {
        females: totalF,
        males: totalM,
        entryDate: oldestEntry || todayISO(),
        initialAgeWeeks: maxInitAge
    });
}

async function ensureFlocksMigratedIfNeeded() {
    if (state.breedersFlocks && Object.keys(state.breedersFlocks).length > 0) return;
    const legF = Number(state.flockData?.females) || 0;
    const legM = Number(state.flockData?.males) || 0;
    if (legF > 0 || legM > 0) {
        const mainObj = {
            name: 'القطيع الأساسي',
            location: 'العنبر الرئيسي',
            breed: 'سمان ياباني / هجين',
            females: legF,
            males: legM,
            entryDate: state.flockData.entryDate || todayISO(),
            initialAgeWeeks: Number(state.flockData.initialAgeWeeks) || 0,
            notes: 'تم الترحيل التلقائي من السجل السابق',
            createdAt: Date.now()
        };
        await set(ref(db, 'inventory/breedersFlocks/main_flock'), mainObj);
        state.breedersFlocks = { main_flock: mainObj };
    }
}

function computeBreedersAnalytics() {
    const now = Date.now();
    const days7Ago = now - 7 * 86400000;
    const days30Ago = now - 30 * 86400000;
    const logs = Object.entries(state.breedersLogs || {}).map(([id, l]) => ({ id, ...l }));

    const logs7 = logs.filter((l) => (l.timestamp || new Date(l.date || 0).getTime()) >= days7Ago);
    const totalGood7 = logs7.reduce((s, l) => s + (Number(l.good) || 0), 0);
    const totalDays7 = Math.max(1, logs7.reduce((s, l) => s + (Number(l.daysCount) || 1), 0));
    const avgDailyGoodEggs = logs7.length > 0 ? Math.round(totalGood7 / Math.min(7, totalDays7)) : 0;
    const avgProdRate7 = logs7.length > 0
        ? (logs7.reduce((s, l) => s + (Number(l.prodRate) || 0), 0) / logs7.length).toFixed(1)
        : 0;

    const logs30 = logs.filter((l) => (l.timestamp || new Date(l.date || 0).getTime()) >= days30Ago);
    const totalEggs30 = logs30.reduce((s, l) => s + (Number(l.total) || 0), 0);
    const totalGood30 = logs30.reduce((s, l) => s + (Number(l.good) || 0), 0);

    let breederCost30 = 0;
    const scanCosts = (ledgerObj) => {
        Object.values(ledgerObj || {}).forEach((t) => {
            const ts = t.timestamp || new Date(t.date || 0).getTime();
            if (ts < days30Ago) return;
            const isBreederCost =
                t.batchId === 'breeders' ||
                t.costSource === 'breeder_feed' ||
                (t.desc || '').includes('أمهات');
            if (!isBreederCost) return;
            if (t.type === 'batch_cost' || (t.type === 'out' && t.category !== 'flock_setup')) {
                breederCost30 += Number(t.amount) || 0;
            }
        });
    };
    scanCosts(state.ledger);
    scanCosts(state.archivedLedger);

    const costPerEgg = totalEggs30 > 0 ? round2(breederCost30 / totalEggs30) : 0;
    const costPerHatchEgg = totalGood30 > 0 ? round2(breederCost30 / totalGood30) : 0;

    const totalShelves = Math.max(1, Number(state.settings.setIncShelves) || 12);
    const shelfCap = Math.max(1, Number(state.settings.setIncShelfCapacity) || 500);
    let emptyShelves = 0;
    for (let i = 1; i <= totalShelves; i++) {
        if (!state.incubatorGrid[`shelf_${i}`]) emptyShelves++;
    }
    const emptyCapacity = emptyShelves * shelfCap;
    const readyEggs = Number(state.readyEggsStock) || 0;
    const neededToFill = Math.max(0, emptyCapacity - readyEggs);
    const daysToFill = avgDailyGoodEggs > 0 && neededToFill > 0 ? Math.ceil(neededToFill / avgDailyGoodEggs) : 0;

    let freshnessWarning = '';
    if (readyEggs > 0 && logs.length > 0) {
        const sortedDesc = [...logs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        let acc = 0;
        let oldestTimestamp = now;
        for (const l of sortedDesc) {
            acc += Number(l.good) || 0;
            oldestTimestamp = l.timestamp || new Date(l.date || now).getTime();
            if (acc >= readyEggs) break;
        }
        const storageDays = Math.floor((now - oldestTimestamp) / 86400000);
        if (storageDays >= 7) {
            freshnessWarning = `🚨 تنبيه طزاجة: أقدم بيض في رصيد التفريخ مخزّن منذ ${storageDays} أيام — أدخله المكنة فوراً أو حوّله لبيض مائدة قبل انهيار الفقس!`;
        } else if (storageDays >= 5) {
            freshnessWarning = `⏳ تنبيه: أقدم بيض للتفريخ عمره ${storageDays} أيام (يفضّل التحضين قبل 7 أيام).`;
        }
    }

    return {
        avgDailyGoodEggs, avgProdRate7, costPerEgg, costPerHatchEgg,
        emptyShelves, neededToFill, daysToFill, freshnessWarning
    };
}

export function renderBreeders() {
    const flocks = getFlocksList();
    const totalFemales = flocks.reduce((s, f) => s + (Number(f.females) || 0), 0);
    const totalMales = flocks.reduce((s, f) => s + (Number(f.males) || 0), 0);
    const totalBirds = totalFemales + totalMales;
    const avgAge = flocks.length > 0
        ? Math.round(flocks.reduce((s, f) => s + calcFlockAgeWeeks(f), 0) / flocks.length)
        : getTrueFlockAgeWeeks();

    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    setEl('activeMothersCount', fmtNum(totalBirds));
    setEl('activeFemalesCount', fmtNum(totalFemales));
    setEl('activeMalesCount', fmtNum(totalMales));
    setEl('flockAgeDisplay', fmtNum(avgAge));
    setEl('readyEggsCount', fmtNum(state.readyEggsStock));
    setEl('tableEggsCount', fmtNum(state.tableEggsStock));
    setEl('availEggsForShelf', fmtNum(state.readyEggsStock));

    const ratioMeta = getRatioAnalysis(totalFemales, totalMales, avgAge);
    const badge = document.getElementById('fertilityBadge');
    if (badge) {
        badge.style.background = ratioMeta.color;
        badge.textContent = totalBirds > 0
            ? `إخصاب ~${ratioMeta.pct}% (${ratioMeta.ratioText})`
            : 'لا يوجد قطيع';
    }

    const analytics = computeBreedersAnalytics();
    const intelEl = document.getElementById('breedersIntelPanel');
    if (intelEl) {
        const fillMsg = analytics.emptyShelves === 0
            ? 'المكنة ممتلئة بالكامل حالياً 🟢'
            : (analytics.neededToFill === 0
                ? `🎉 رصيدك يكفي لملء كل الأرفف الفارغة (${analytics.emptyShelves} رف) الآن!`
                : `متبقي <b>${fmtNum(analytics.neededToFill)} بيضة</b> لملء ${analytics.emptyShelves} رف فارغ` +
                  (analytics.daysToFill > 0 ? ` (بمعدلك الحالي خلال <b>${analytics.daysToFill} يوم</b>)` : ''));

        intelEl.innerHTML = `
            <div class="grid-3" style="margin-bottom:10px;">
                <div class="mini-kpi">
                    <span>متوسط إنتاج (7 أيام)</span>
                    <strong class="text-primary">${fmtNum(analytics.avgDailyGoodEggs)} بيضة/يوم</strong>
                    <div class="sub-text" style="font-size:10px;">كفاءة وضع: ${analytics.avgProdRate7}%</div>
                </div>
                <div class="mini-kpi">
                    <span>تكلفة البيضة (30 يوم)</span>
                    <strong class="text-warning">${analytics.costPerEgg > 0 ? fmtMoney(analytics.costPerEgg) + ' ج' : '-'}</strong>
                    <div class="sub-text" style="font-size:10px;">صالح للتفريخ: ${analytics.costPerHatchEgg > 0 ? fmtMoney(analytics.costPerHatchEgg) + ' ج' : '-'}</div>
                </div>
                <div class="mini-kpi">
                    <span>النسبة الجنسية</span>
                    <strong style="color:${ratioMeta.color};">${ratioMeta.ratioText}</strong>
                    <div class="sub-text" style="font-size:10px;">${ratioMeta.status}</div>
                </div>
            </div>
            <div class="info-box" style="font-size:12px; margin-bottom:8px;">
                <i class="fas fa-calculator text-primary"></i> <b>حاسبة ملء المكنة:</b> ${fillMsg}
            </div>
            <div class="info-box" style="font-size:12px; border-right:3px solid ${ratioMeta.color};">
                <i class="fas fa-lightbulb" style="color:${ratioMeta.color};"></i> <b>توصية التلقيح:</b> ${ratioMeta.advice}
            </div>
            ${analytics.freshnessWarning ? `<div class="alert-box alert-danger" style="margin-top:8px;">${analytics.freshnessWarning}</div>` : ''}
        `;
    }

    renderFlocksCards(flocks);
    renderProductionChart();
    renderBreedersLogsPanel();
}

function renderFlocksCards(flocks) {
    const container = document.getElementById('flocksListContainer');
    if (!container) return;

    if (flocks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                لا توجد قطعان أمهات مسجلة حالياً.<br>
                <div style="margin-top:10px; display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
                    <button class="btn btn-primary btn-sm" onclick="openFlockModal()"><i class="fas fa-plus"></i> إضافة قطيع جديد</button>
                    <button class="btn btn-info btn-sm" onclick="openPromoteRearingModal()"><i class="fas fa-right-left"></i> تحويل من عنبر التربية</button>
                </div>
            </div>`;
        return;
    }

    container.innerHTML = flocks.map((f) => {
        const age = calcFlockAgeWeeks(f);
        const stage = getFlockStageMeta(age);
        const females = Number(f.females) || 0;
        const males = Number(f.males) || 0;
        const total = females + males;
        const ratio = getRatioAnalysis(females, males, age);
        const dailyFeedNeed = (total * 0.033).toFixed(1);

        return `
        <div class="flock-pro-card" style="border-right-color:${stage.color};">
            <div class="batch-top" style="margin-bottom:8px;">
                <div>
                    <strong style="font-size:16px;">🕊️ ${escapeHtml(f.name || 'قطيع أمهات')}</strong>
                    <div class="sub-text">${escapeHtml(f.location || 'العنبر الرئيسي')} • ${escapeHtml(f.breed || 'سمان')} • عمر <b>${age} أسبوع</b></div>
                </div>
                <span class="badge" style="background:${stage.color};">${stage.label}</span>
            </div>

            <div class="grid-4" style="margin:10px 0;">
                <div class="mini-kpi"><span>إناث</span><strong style="color:#ec4899;">${fmtNum(females)}</strong></div>
                <div class="mini-kpi"><span>ذكور</span><strong style="color:#0ea5e9;">${fmtNum(males)}</strong></div>
                <div class="mini-kpi"><span>النسبة</span><strong style="color:${ratio.color};">${ratio.ratioText}</strong></div>
                <div class="mini-kpi"><span>علف/يوم</span><strong class="text-warning">${dailyFeedNeed} ك</strong></div>
            </div>

            ${f.notes ? `<div class="sub-text" style="margin-bottom:8px;"><i class="fas fa-note-sticky"></i> ${escapeHtml(f.notes)}</div>` : ''}

            <div class="batch-actions" style="margin-top:8px; padding-top:10px;">
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="act-btn" onclick="openFlockModal('${f.id}')" style="color:var(--info);"><i class="fas fa-pen"></i> تعديل</button>
                    <button class="act-btn" onclick="openBreederDailyModal('${f.id}')" style="color:var(--purple);"><i class="fas fa-clipboard-list"></i> يومية</button>
                    <button class="act-btn" onclick="openLiquidateFlockModal('${f.id}')" style="color:var(--success);"><i class="fas fa-hand-holding-dollar"></i> تصفية</button>
                    <button class="act-btn" onclick="deleteFlock('${f.id}')" style="color:var(--danger);"><i class="fas fa-trash"></i></button>
                </div>
                <button class="btn btn-primary btn-sm" onclick="openTriageModal('${f.id}')"><i class="fas fa-egg"></i> فرز بيض</button>
            </div>
        </div>`;
    }).join('');
}

function renderProductionChart() {
    const el = document.getElementById('breedersProdChart');
    if (!el) return;

    const logs = Object.values(state.breedersLogs || {})
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .slice(-14);

    if (logs.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:14px;">سجّل أول فرز بيض ليظهر الرسم البياني الحي لمنحنى الإنتاج.</div>';
        return;
    }

    const maxTotal = Math.max(...logs.map((l) => Number(l.total) || 1), 1);
    const barsHtml = logs.map((l) => {
        const total = Number(l.total) || 0;
        const rate = Number(l.prodRate) || 0;
        const heightPct = Math.max(12, Math.round((total / maxTotal) * 100));
        const barColor = rate >= 75 ? 'var(--success)' : (rate >= 60 ? 'var(--warning)' : 'var(--danger)');
        const shortDate = (l.date || '').slice(5);
        return `
        <div class="prod-bar-col" title="${escapeHtml(l.date || '')}: ${total} بيضة (${rate}%)">
            <span class="prod-bar-val">${total}</span>
            <div class="prod-bar-track">
                <div class="prod-bar-fill" style="height:${heightPct}%; background:${barColor};"></div>
            </div>
            <span class="prod-bar-date">${escapeHtml(shortDate)}</span>
        </div>`;
    }).join('');

    el.innerHTML = `<div class="prod-chart-wrap">${barsHtml}</div>`;
}

export function switchBreedersLogTab(tabName) {
    activeBreederLogTab = tabName;
    document.querySelectorAll('.b-log-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.logTab === tabName);
    });
    renderBreedersLogsPanel();
}

function renderBreedersLogsPanel() {
    const el = document.getElementById('breedersRecentLogs');
    if (!el) return;

    if (activeBreederLogTab === 'triage') {
        const entries = Object.entries(state.breedersLogs || {})
            .sort(([, a], [, b]) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 15);

        if (entries.length === 0) {
            el.innerHTML = '<div class="empty-state">لا توجد سجلات فرز بيض بعد.</div>';
            return;
        }

        el.innerHTML = entries.map(([id, l]) => `
            <div class="mini-log-row">
                <div style="flex:1;">
                    <strong>${escapeHtml(l.date || '-')}</strong>
                    ${l.flockName ? `<span class="pill-tag pill-info">${escapeHtml(l.flockName)}</span>` : ''}
                    <span class="sub-text">(${l.daysCount > 1 ? l.daysCount + ' أيام' : 'يومي'})</span>
                    <div class="sub-text">كلي: <b>${l.total}</b> | تفريخ: <b class="text-success">${l.good}</b> | مائدة: <b class="text-info">${l.tableEggs || 0}</b> | كسر: <b class="text-danger">${l.bad}</b></div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="badge" style="background:${Number(l.prodRate) >= 75 ? 'var(--success)' : 'var(--warning)'};">${l.prodRate}%</span>
                    <button class="icon-btn-danger" onclick="deleteTriageLog('${id}')" title="حذف وعكس رصيد البيض"><i class="fas fa-trash-alt"></i></button>
                </div>
            </div>
        `).join('');
    } else {
        const entries = Object.entries(state.breedersHistoryLogs || {})
            .sort(([, a], [, b]) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 15);

        if (entries.length === 0) {
            el.innerHTML = '<div class="empty-state">لا توجد سجلات يوميات أمهات بعد.</div>';
            return;
        }

        el.innerHTML = entries.map(([id, l]) => `
            <div class="mini-log-row">
                <div style="flex:1;">
                    <strong>${escapeHtml(l.date || '-')}</strong>
                    ${l.flockName ? `<span class="pill-tag pill-warn">${escapeHtml(l.flockName)}</span>` : ''}
                    <div class="sub-text">
                        نافق: <b class="text-danger">${l.deadFemales || 0} إ / ${l.deadMales || 0} ذ</b>
                        ${(l.culledFemales || l.culledMales) ? ` | استبعاد: <b>${l.culledFemales || 0} إ / ${l.culledMales || 0} ذ</b>` : ''}
                        ${l.feedConsumed ? ` | علف: <b class="text-warning">${l.feedConsumed} كجم</b>` : ''}
                    </div>
                </div>
                <button class="icon-btn-danger" onclick="deleteBreederHistoryLog('${id}')" title="حذف وعكس الأثر"><i class="fas fa-trash-alt"></i></button>
            </div>
        `).join('');
    }
}

export function openFlockModal(flockId = null) {
    const flocks = getFlocksList();
    const target = flockId ? flocks.find((f) => f.id === flockId) : null;

    document.getElementById('flockEditId').value = target && !target.isLegacy ? target.id : (target?.isLegacy ? 'main_flock' : '');
    document.getElementById('flockModalTitle').textContent = target ? `✏️ تعديل قطيع: ${target.name}` : '➕ إضافة قطيع أمهات جديد';
    document.getElementById('flockNameInput').value = target ? (target.name || '') : `قطيع أمهات #${flocks.length + 1}`;
    document.getElementById('flockLocationInput').value = target ? (target.location || '') : '';
    document.getElementById('flockBreedInput').value = target ? (target.breed || 'سمان ياباني') : 'سمان ياباني';
    document.getElementById('manualFemalesCount').value = target ? (target.females || 0) : '';
    document.getElementById('manualMalesCount').value = target ? (target.males || 0) : '';
    document.getElementById('flockEntryDateInput').value = target ? (target.entryDate || todayISO()) : todayISO();
    document.getElementById('flockInitialAgeWeeks').value = target ? (target.initialAgeWeeks ?? 6) : 6;
    document.getElementById('flockNotesInput').value = target ? (target.notes || '') : '';
    document.getElementById('flockInitialCost').value = '';

    openModal('modalFlockUpdate');
}

export const openFlockSetupModal = () => openFlockModal(null);

export async function updateFlockLedger() {
    await withActionLock('saveFlock', async () => {
        await ensureFlocksMigratedIfNeeded();
        const editId = document.getElementById('flockEditId')?.value || '';
        const name = parseRequiredText(document.getElementById('flockNameInput')?.value, 'اسم القطيع');
        const females = parsePositiveNumber(document.getElementById('manualFemalesCount')?.value, 'عدد الإناث', { allowZero: true, isInt: true });
        const males = parsePositiveNumber(document.getElementById('manualMalesCount')?.value, 'عدد الذكور', { allowZero: true, isInt: true });
        const initialAgeWeeks = parsePositiveNumber(document.getElementById('flockInitialAgeWeeks')?.value || '0', 'العمر عند الدخول', { allowZero: true, isInt: true });
        const cost = parsePositiveNumber(document.getElementById('flockInitialCost')?.value || '0', 'تكلفة التأسيس', { allowZero: true });
        const entryDate = document.getElementById('flockEntryDateInput')?.value || todayISO();
        const location = (document.getElementById('flockLocationInput')?.value || '').trim() || 'العنبر الرئيسي';
        const breed = (document.getElementById('flockBreedInput')?.value || '').trim() || 'سمان ياباني';
        const notes = (document.getElementById('flockNotesInput')?.value || '').trim();

        if (!name || females === null || males === null || initialAgeWeeks === null || cost === null) return;

        const id = editId || ('flock_' + Date.now());
        const flockObj = {
            name, location, breed, females, males, entryDate, initialAgeWeeks, notes,
            createdAt: state.breedersFlocks?.[id]?.createdAt || Date.now()
        };

        await set(ref(db, `inventory/breedersFlocks/${id}`), flockObj);
        const nextAll = { ...(state.breedersFlocks || {}), [id]: flockObj };
        await syncTotalsToLegacyFlockData(nextAll);

        if (cost > 0) {
            await recordCashTransaction({
                type: 'out',
                amount: cost,
                desc: `تأسيس/شراء ${name} (${females} إناث، ${males} ذكور)`,
                batchId: 'breeders',
                category: 'flock_setup'
            });
        }

        closeModal('modalFlockUpdate');
        showToast(`تم حفظ "${name}" بنجاح 🕊️`);
    }, 'جاري حفظ بيانات القطيع...');
}

export async function deleteFlock(flockId) {
    const target = getFlocksList().find((f) => f.id === flockId);
    if (!target) return;
    if (!confirm(`⚠️ هل أنت متأكد من حذف قطيع "${target.name}" (${target.females} إناث / ${target.males} ذكور)؟`)) return;

    await withActionLock(`delFlock_${flockId}`, async () => {
        if (target.isLegacy) {
            await set(ref(db, 'inventory/flockData'), { females: 0, males: 0, entryDate: '', initialAgeWeeks: 0 });
        } else {
            await remove(ref(db, `inventory/breedersFlocks/${flockId}`));
            const nextAll = { ...(state.breedersFlocks || {}) };
            delete nextAll[flockId];
            await syncTotalsToLegacyFlockData(nextAll);
        }
        showToast(`تم حذف "${target.name}" بنجاح`);
    });
}

export function openLiquidateFlockModal(flockId) {
    const target = getFlocksList().find((f) => f.id === flockId);
    if (!target) return;
    document.getElementById('liqFlockId').value = flockId;
    document.getElementById('liqFlockInfo').textContent = `${target.name} (${target.females} إناث + ${target.males} ذكور = ${target.females + target.males} طائر)`;
    document.getElementById('liqFlockRevenue').value = '';
    openModal('modalLiquidateFlock');
}

export async function confirmLiquidateFlock() {
    await withActionLock('liqFlock', async () => {
        const flockId = document.getElementById('liqFlockId')?.value;
        const target = getFlocksList().find((f) => f.id === flockId);
        if (!target) return;

        const revenue = parsePositiveNumber(document.getElementById('liqFlockRevenue')?.value || '0', 'إيراد التصفية', { allowZero: true });
        if (revenue === null) return;

        if (revenue > 0) {
            await recordCashTransaction({
                type: 'in',
                amount: revenue,
                desc: `تصفية/بيع قطيع أمهات: ${target.name} (${target.females + target.males} طائر)`,
                batchId: 'breeders',
                category: 'flock_liquidation'
            });
        }

        if (target.isLegacy) {
            await set(ref(db, 'inventory/flockData'), { females: 0, males: 0, entryDate: '', initialAgeWeeks: 0 });
        } else {
            await remove(ref(db, `inventory/breedersFlocks/${flockId}`));
            const nextAll = { ...(state.breedersFlocks || {}) };
            delete nextAll[flockId];
            await syncTotalsToLegacyFlockData(nextAll);
        }

        closeModal('modalLiquidateFlock');
        showToast(`تمت تصفية "${target.name}" وتسجيل الإيراد بنجاح 💰`);
    }, 'جاري تصفية القطيع...');
}

export function openPromoteRearingModal() {
    const sel = document.getElementById('promoteBatchSelect');
    if (!sel) return;
    const rearingList = Object.entries(state.batches || {}).filter(([, b]) => b.status === 'rearing');
    if (rearingList.length === 0) {
        return showToast('لا توجد دفعات حالياً في عنابر التربية لتحويلها لأمهات', true);
    }

    sel.innerHTML = rearingList.map(([id, b]) => {
        const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));
        const ageDays = b.hatchDate ? Math.max(1, Math.floor((Date.now() - new Date(b.hatchDate).getTime()) / 86400000)) : 1;
        return `<option value="${id}">${escapeHtml(b.name)} (متاح ${alive} طائر • عمر ${ageDays} يوم)</option>`;
    }).join('');

    document.getElementById('promoteFlockName').value = `قطيع إحلال ${todayISO()}`;
    document.getElementById('promoteFemales').value = '';
    document.getElementById('promoteMales').value = '';
    openModal('modalPromoteToBreeder');
}

export async function confirmPromoteToBreeder() {
    await withActionLock('promoteToBreeder', async () => {
        await ensureFlocksMigratedIfNeeded();
        const batchId = document.getElementById('promoteBatchSelect')?.value;
        const b = state.batches[batchId];
        if (!b) return;

        const name = parseRequiredText(document.getElementById('promoteFlockName')?.value, 'اسم قطيع الإحلال');
        const females = parsePositiveNumber(document.getElementById('promoteFemales')?.value, 'عدد الإناث', { isInt: true });
        const males = parsePositiveNumber(document.getElementById('promoteMales')?.value || '0', 'عدد الذكور', { allowZero: true, isInt: true });
        if (!name || females === null || males === null) return;

        const totalMoved = females + males;
        const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));
        if (totalMoved > alive) {
            return showToast(`العدد المطلوب تحويله (${totalMoved}) أكبر من المتاح بالدفعة (${alive})!`, true);
        }

        const ageWeeks = b.hatchDate ? Math.max(1, Math.round((Date.now() - new Date(b.hatchDate).getTime()) / (7 * 86400000))) : 5;
        const newFlockId = 'flock_' + Date.now();
        const flockObj = {
            name,
            location: 'عنبر الإحلال',
            breed: b.birdType === 'quail' ? 'سمان محلي (إحلال المزرعة)' : (b.birdType || 'سمان'),
            females,
            males,
            entryDate: todayISO(),
            initialAgeWeeks: ageWeeks,
            notes: `تم تحويله من دفعة التربية: ${b.name}`,
            sourceBatchId: batchId,
            createdAt: Date.now()
        };

        await set(ref(db, `inventory/breedersFlocks/${newFlockId}`), flockObj);
        const nextAll = { ...(state.breedersFlocks || {}), [newFlockId]: flockObj };
        await syncTotalsToLegacyFlockData(nextAll);
        await atomicAdjust(`batches/${batchId}/hatchedChicks`, -totalMoved, { allowNegative: false, decimals: 0 });

        closeModal('modalPromoteToBreeder');
        showToast(`تم تحويل ${totalMoved} طائر إلى "${name}" بنجاح 🕊️🚀`);
    }, 'جاري تحويل الطيور لقطيع الأمهات...');
}

export function openEggControlModal() {
    document.getElementById('ecReadyNow').textContent = fmtNum(state.readyEggsStock);
    document.getElementById('ecTableNow').textContent = fmtNum(state.tableEggsStock);
    document.getElementById('ecActionType').value = 'ready_to_table';
    document.getElementById('ecQty').value = '';
    document.getElementById('ecCost').value = '';
    toggleEggControlFields();
    openModal('modalEggControl');
}

export function toggleEggControlFields() {
    const action = document.getElementById('ecActionType')?.value;
    const costWrap = document.getElementById('ecCostWrap');
    if (costWrap) costWrap.style.display = action === 'buy_hatching' ? 'block' : 'none';
}

export async function confirmEggControlAction() {
    await withActionLock('eggControl', async () => {
        const action = document.getElementById('ecActionType')?.value;
        const qty = parsePositiveNumber(document.getElementById('ecQty')?.value, 'العدد', { isInt: true, allowZero: action === 'set_ready' || action === 'set_table' });
        if (qty === null) return;

        if (action === 'ready_to_table') {
            if (qty > state.readyEggsStock) return showToast(`المتاح في بيض التفريخ ${state.readyEggsStock} فقط!`, true);
            await atomicAdjust('inventory/readyEggsStock', -qty, { allowNegative: false, decimals: 0 });
            await atomicAdjust('inventory/tableEggsStock', qty, { allowNegative: false, decimals: 0 });
            showToast(`تم تحويل ${qty} بيضة من التفريخ إلى المائدة ✅`);
        } else if (action === 'table_to_ready') {
            if (qty > state.tableEggsStock) return showToast(`المتاح في بيض المائدة ${state.tableEggsStock} فقط!`, true);
            await atomicAdjust('inventory/tableEggsStock', -qty, { allowNegative: false, decimals: 0 });
            await atomicAdjust('inventory/readyEggsStock', qty, { allowNegative: false, decimals: 0 });
            showToast(`تم تحويل ${qty} بيضة من المائدة إلى التفريخ ✅`);
        } else if (action === 'buy_hatching') {
            const cost = parsePositiveNumber(document.getElementById('ecCost')?.value || '0', 'التكلفة الإجمالية', { allowZero: true });
            if (cost === null) return;
            await atomicAdjust('inventory/readyEggsStock', qty, { allowNegative: false, decimals: 0 });
            if (cost > 0) {
                await recordCashTransaction({
                    type: 'out',
                    amount: cost,
                    desc: `شراء بيض تفريخ خارجي (${qty} بيضة)`,
                    batchId: 'breeders',
                    category: 'hatching_eggs_purchase'
                });
            }
            showToast(`تمت إضافة ${qty} بيضة تفريخ لرصيدك 🥚`);
        } else if (action === 'set_ready') {
            await set(ref(db, 'inventory/readyEggsStock'), qty);
            showToast(`تم ضبط رصيد بيض التفريخ على ${qty} بيضة`);
        } else if (action === 'set_table') {
            await set(ref(db, 'inventory/tableEggsStock'), qty);
            showToast(`تم ضبط رصيد بيض المائدة على ${qty} بيضة`);
        }

        closeModal('modalEggControl');
    }, 'جاري تحديث مخزون البيض...');
}

export function openBreederDailyModal(preselectedFlockId = null) {
    const flocks = getFlocksList();
    if (flocks.length === 0) return showToast('أضف قطيع أمهات أولاً!', true);

    const sel = document.getElementById('bdFlockSelect');
    if (sel) {
        sel.innerHTML = flocks.map((f) =>
            `<option value="${f.id}">${escapeHtml(f.name)} (${f.females} إ / ${f.males} ذ)</option>`
        ).join('');
        if (preselectedFlockId) sel.value = preselectedFlockId;
    }

    ['bdDeadFemales', 'bdDeadMales', 'bdCulledFemales', 'bdCulledMales', 'bdCulledRevenue', 'bdFeed'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '0';
    });
    openModal('modalBreederDaily');
}

export async function saveBreederDailyLog() {
    await withActionLock('breederDaily', async () => {
        await ensureFlocksMigratedIfNeeded();
        let flockId = document.getElementById('bdFlockSelect')?.value || '';
        if (flockId === 'legacy_main') flockId = 'main_flock';
        const flock = state.breedersFlocks?.[flockId];
        if (!flock) return showToast('اختر قطيعاً صحيحاً', true);

        const deadF = parsePositiveNumber(document.getElementById('bdDeadFemales')?.value || '0', 'نافق الإناث', { allowZero: true, isInt: true });
        const deadM = parsePositiveNumber(document.getElementById('bdDeadMales')?.value || '0', 'نافق الذكور', { allowZero: true, isInt: true });
        const culledF = parsePositiveNumber(document.getElementById('bdCulledFemales')?.value || '0', 'استبعاد الإناث', { allowZero: true, isInt: true });
        const culledM = parsePositiveNumber(document.getElementById('bdCulledMales')?.value || '0', 'استبعاد الذكور', { allowZero: true, isInt: true });
        const culledRev = parsePositiveNumber(document.getElementById('bdCulledRevenue')?.value || '0', 'إيراد بيع الاستبعاد', { allowZero: true });
        const feed = parsePositiveNumber(document.getElementById('bdFeed')?.value || '0', 'العلف المستهلك', { allowZero: true });

        if (deadF === null || deadM === null || culledF === null || culledM === null || culledRev === null || feed === null) return;

        const remF = deadF + culledF;
        const remM = deadM + culledM;
        if (remF === 0 && remM === 0 && feed === 0 && culledRev === 0) return showToast('أدخل بياناً واحداً على الأقل', true);
        if (remF > (Number(flock.females) || 0)) return showToast(`المخصوم (${remF}) أكبر من إناث القطيع (${flock.females})!`, true);
        if (remM > (Number(flock.males) || 0)) return showToast(`المخصوم (${remM}) أكبر من ذكور القطيع (${flock.males})!`, true);

        if (feed > 0) {
            await consumeFeedFromStock({
                qtyKg: feed,
                batchId: 'breeders',
                desc: `علف أمهات (${feed} كجم) - ${flock.name}`
            });
        }

        const nextF = (Number(flock.females) || 0) - remF;
        const nextM = (Number(flock.males) || 0) - remM;
        await update(ref(db, `inventory/breedersFlocks/${flockId}`), { females: nextF, males: nextM });
        const nextAll = { ...(state.breedersFlocks || {}), [flockId]: { ...flock, females: nextF, males: nextM } };
        await syncTotalsToLegacyFlockData(nextAll);

        if (culledRev > 0) {
            await recordCashTransaction({
                type: 'in',
                amount: culledRev,
                desc: `بيع استبعاد أمهات (${culledF} إ، ${culledM} ذ) - ${flock.name}`,
                batchId: 'breeders',
                category: 'breeder_cull_sale'
            });
        }

        await push(ref(db, 'breedersHistoryLogs'), {
            date: todayISO(), flockId, flockName: flock.name,
            deadFemales: deadF, deadMales: deadM, culledFemales: culledF, culledMales: culledM,
            culledRevenue: culledRev, feedConsumed: feed, timestamp: Date.now()
        });

        closeModal('modalBreederDaily');
        showToast(`تم تسجيل يومية "${flock.name}" بنجاح 📝`);
    }, 'جاري حفظ يومية الأمهات...');
}

export function openTriageModal(preselectedFlockId = null) {
    const flocks = getFlocksList();
    const sel = document.getElementById('triageFlockSelect');
    if (sel) {
        let html = '<option value="all">كل قطعان الأمهات (إجمالي المزرعة)</option>';
        flocks.forEach((f) => {
            html += `<option value="${f.id}">${escapeHtml(f.name)} (${f.females} أنثى)</option>`;
        });
        sel.innerHTML = html;
        if (preselectedFlockId) sel.value = preselectedFlockId;
    }

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
        const bad = parsePositiveNumber(document.getElementById('triageBad')?.value || '0', 'البيض المكسور', { allowZero: true, isInt: true });
        const mode = document.getElementById('triagePeriodMode')?.value || 'daily';
        const flockId = document.getElementById('triageFlockSelect')?.value || 'all';

        if (total === null || tableEggs === null || bad === null) return;
        if (tableEggs + bad > total) return showToast('مجموع بيض المائدة والكسر أكبر من الكلي!', true);

        const flocks = getFlocksList();
        let targetFemales = 0;
        let flockName = 'كل القطعان';
        let flockAge = getTrueFlockAgeWeeks();

        if (flockId === 'all') {
            targetFemales = flocks.reduce((s, f) => s + (Number(f.females) || 0), 0);
        } else {
            const target = flocks.find((f) => f.id === flockId);
            if (target) {
                targetFemales = Number(target.females) || 0;
                flockName = target.name;
                flockAge = calcFlockAgeWeeks(target);
            }
        }
        if (targetFemales <= 0) return showToast('قم بإضافة عدد الإناث في القطيع أولاً!', true);

        let daysCount = 1;
        let dateText = 'الإنتاج اليومي';
        if (mode === 'period') {
            const start = document.getElementById('triageStartDate')?.value;
            const end = document.getElementById('triageEndDate')?.value;
            if (!start || !end) return showToast('حدد تواريخ الفترة', true);
            const d1 = new Date(start);
            const d2 = new Date(end);
            if (d2 < d1) return showToast('تاريخ النهاية يجب أن يكون بعد البداية', true);
            daysCount = Math.floor((d2 - d1) / 86400000) + 1;
            dateText = `إنتاج متراكم (${daysCount} أيام)`;
        }

        const good = total - tableEggs - bad;
        const validRate = Number(((good / total) * 100).toFixed(1));
        const prodRate = Number(((total / (targetFemales * daysCount)) * 100).toFixed(1));

        if (good > 0) await atomicAdjust('inventory/readyEggsStock', good, { allowNegative: false, decimals: 0 });
        if (tableEggs > 0) await atomicAdjust('inventory/tableEggsStock', tableEggs, { allowNegative: false, decimals: 0 });

        await push(ref(db, 'breedersLogs'), {
            date: todayISO(), flockId, flockName, mode, daysCount,
            females: targetFemales, flockAge, total, good, tableEggs, bad, validRate, prodRate, timestamp: Date.now()
        });

        let warnings = '';
        if (flockAge >= 28) warnings += `<li><strong>تنبيه إحلال:</strong> عمر القطيع وصل ${flockAge} أسبوع — جهّز قطيع إحلال قريباً.</li>`;
        if (validRate < 85) warnings += `<li><strong>نسبة الصالح للتفريخ (${validRate}%) منخفضة:</strong> راجع الكالسيوم وفيتامين D3 وتكرار جمع البيض.</li>`;
        if (prodRate < 75) warnings += `<li><strong>معدل الإنتاج (${prodRate}%) أقل من 75%:</strong> راجع الإضاءة (15–16 ساعة) وبروتين العلف (19–20%).</li>`;

        const reportEl = document.getElementById('triageReportContent');
        if (reportEl) {
            reportEl.innerHTML = `
                <div class="info-box">
                    <div><strong>${escapeHtml(flockName)} • ${dateText}:</strong> ${fmtNum(total)} بيضة من ${fmtNum(targetFemales)} أنثى</div>
                    <div class="text-success"><strong>صالح للتفريخ:</strong> ${fmtNum(good)} (${validRate}%)</div>
                    <div class="text-info"><strong>بيض مائدة:</strong> ${fmtNum(tableEggs)}</div>
                    <div class="text-danger"><strong>كسر / معدم:</strong> ${fmtNum(bad)}</div>
                    <div style="margin-top:8px;"><strong>كفاءة الإنتاج:</strong> <span class="badge" style="background:${prodRate >= 75 ? 'var(--success)' : 'var(--warning)'};">${prodRate}%</span></div>
                </div>
                ${warnings ? `<div class="alert-box alert-danger"><h4>توصيات المستشار الفني:</h4><ul>${warnings}</ul></div>` : `<div class="alert-box alert-success">✅ الأداء وجودة القشرة ممتازان!</div>`}
            `;
        }

        closeModal('modalDailyTriage');
        openModal('modalTriageReport');
    }, 'جاري تحليل وحفظ الفرز...');
}

export async function deleteTriageLog(logId) {
    const log = state.breedersLogs?.[logId];
    if (!log) return;
    if (!confirm(`حذف سجل فرز يوم ${log.date} وعكس أثره من مخزون البيض؟`)) return;

    await withActionLock(`delTriage_${logId}`, async () => {
        if (Number(log.good) > 0) {
            await set(ref(db, 'inventory/readyEggsStock'), Math.max(0, (Number(state.readyEggsStock) || 0) - Number(log.good)));
        }
        if (Number(log.tableEggs) > 0) {
            await set(ref(db, 'inventory/tableEggsStock'), Math.max(0, (Number(state.tableEggsStock) || 0) - Number(log.tableEggs)));
        }
        await remove(ref(db, `breedersLogs/${logId}`));
        showToast('تم حذف سجل الفرز وعكس الأرصدة بنجاح ✅');
    });
}

export async function deleteBreederHistoryLog(logId) {
    const log = state.breedersHistoryLogs?.[logId];
    if (!log) return;
    if (!confirm(`حذف سجل يومية ${log.date} وإرجاع الطيور/العلف لأرصدتها؟`)) return;

    await withActionLock(`delBHist_${logId}`, async () => {
        const restoreF = (Number(log.deadFemales) || 0) + (Number(log.culledFemales) || 0);
        const restoreM = (Number(log.deadMales) || 0) + (Number(log.culledMales) || 0);
        if (log.flockId && state.breedersFlocks?.[log.flockId] && (restoreF > 0 || restoreM > 0)) {
            const f = state.breedersFlocks[log.flockId];
            const nextF = (Number(f.females) || 0) + restoreF;
            const nextM = (Number(f.males) || 0) + restoreM;
            await update(ref(db, `inventory/breedersFlocks/${log.flockId}`), { females: nextF, males: nextM });
            await syncTotalsToLegacyFlockData({ ...state.breedersFlocks, [log.flockId]: { ...f, females: nextF, males: nextM } });
        }
        if (Number(log.feedConsumed) > 0) {
            await atomicAdjust('inventory/feedStock', Number(log.feedConsumed), { allowNegative: false, decimals: 2 });
        }
        await remove(ref(db, `breedersHistoryLogs/${logId}`));
        showToast('تم حذف اليومية وعكس أثرها بنجاح ✅');
    });
}

export function openBreederExpenseModal() {
    document.getElementById('beAmount').value = '';
    document.getElementById('beDesc').value = '';
    openModal('modalBreederExpense');
}

export async function saveBreederExpense() {
    await withActionLock('breederExp', async () => {
        const amount = parsePositiveNumber(document.getElementById('beAmount')?.value, 'المبلغ');
        const desc = parseRequiredText(document.getElementById('beDesc')?.value, 'البيان (فيتامينات/كالسيوم/أدوية)');
        if (amount === null || !desc) return;

        await recordCashTransaction({
            type: 'out', amount, desc: `أمهات: ${desc}`, batchId: 'breeders', category: 'breeder_care'
        });

        closeModal('modalBreederExpense');
        showToast('تم تسجيل مصروف الأمهات وحسابه في تكلفة البيضة 💊');
    }, 'جاري الحفظ...');
}

export function openSellTableEggsModal() {
    if ((state.tableEggsStock || 0) <= 0) return showToast('لا يوجد رصيد بيض مائدة للبيع حالياً', true);
    document.getElementById('sellTableEggsAvail').textContent = fmtNum(state.tableEggsStock);
    document.getElementById('sellTableEggsQty').value = state.tableEggsStock;
    document.getElementById('sellTableEggsPrice').value = state.settings.quailEgg || 1.5;
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
        if (qty > state.tableEggsStock) return showToast(`المتاح للبيع ${state.tableEggsStock} بيضة فقط`, true);

        const total = round2(qty * price);
        await atomicAdjust('inventory/tableEggsStock', -qty, { allowNegative: false, decimals: 0 });
        await recordCashTransaction({
            type: 'in', amount: total, desc: `بيع بيض مائدة (${qty} بيضة × ${price} ج)`, batchId: 'breeders', category: 'table_eggs_sale'
        });

        closeModal('modalSellTableEggs');
        showToast(`تم بيع ${qty} بيضة مائدة بإيراد ${fmtMoney(total)} ج.م 🥚`);
    }, 'جاري تسجيل البيع...');
}

export function openBreederGuide() {
    const flocks = getFlocksList();
    const total = flocks.reduce((s, f) => s + (Number(f.females) || 0) + (Number(f.males) || 0), 0);
    if (total === 0) return showToast('أضف قطيع أمهات أولاً!', true);

    const feedRec = (total * 0.033).toFixed(1);
    const waterRec = (Number(feedRec) * 2.5).toFixed(1);
    const oldFlocks = flocks.filter((f) => calcFlockAgeWeeks(f) >= 28);

    const html = `
        <div class="grid-2" style="margin-bottom:10px;">
            <div class="guide-tile border-danger"><span class="sub-text">🌡️ الحرارة المثالية</span><strong>21°C - 24°C</strong></div>
            <div class="guide-tile border-warning"><span class="sub-text">💡 برنامج الإضاءة</span><strong>15 - 16 ساعة/يوم</strong></div>
            <div class="guide-tile border-success"><span class="sub-text">🌾 العلف اليومي (${fmtNum(total)} طائر)</span><strong>${feedRec} كجم بياض</strong><div class="sub-text">بروتين 19-20% | كالسيوم 3%</div></div>
            <div class="guide-tile border-info"><span class="sub-text">💧 المياه اليومية</span><strong>${waterRec} لتر</strong></div>
        </div>
        <div class="info-box" style="font-size:13px; line-height:1.9;">
            <strong>📋 بروتوكول الرعاية الأسبوعي للأمهات:</strong><br>
            • <b>جمع البيض:</b> 3 مرات يومياً لتقليل الكسر والتلوث.<br>
            • <b>تخزين بيض التفريخ:</b> حرارة 15–18°م، والحد الأقصى للتخزين 7 أيام.<br>
            • <b>هـ سيلينيوم (للخصوبة):</b> 3 أيام كل أسبوعين.<br>
            • <b>كالسيوم + AD3E (للقشرة):</b> يومين أسبوعياً.
        </div>
        ${oldFlocks.length > 0 ? `<div class="alert-box alert-danger" style="margin-top:10px;"><strong>⚠️ قطعان تجاوزت 28 أسبوع:</strong> ${oldFlocks.map((f) => escapeHtml(f.name)).join('، ')} — جهّز إحلالاً لها.</div>` : ''}
    `;

    const el = document.getElementById('breederGuideContent');
    if (el) el.innerHTML = html;
    openModal('modalBreederGuide');
}
