// www/js/core/state.js
// المخزن المركزي لحالة المزرعة والمعايير البيولوجية والتهيئة

export const DEFAULT_BIRD_STANDARDS = {
    quail: { name: 'سمان', icon: '🕊️', hatcher: 14, hatch: 17, slaughter: 38, avgPairWeightKg: 0.45 },
    chicken: { name: 'فراخ بيضاء', icon: '🐔', hatcher: 18, hatch: 21, slaughter: 40, avgPairWeightKg: 3.8 },
    turkey: { name: 'رومي', icon: '🦃', hatcher: 25, hatch: 28, slaughter: 90, avgPairWeightKg: 14.0 }
};

export const DEFAULT_SETTINGS = {
    farmName: 'سمان ههيا ERP',
    birdType: 'quail',
    feedPrice: 30,
    quailEgg: 1.5,
    chickenEgg: 10,
    turkeyEgg: 25,
    quailChick: 3.5,
    chickenChick: 25,
    turkeyChick: 60,
    setIncShelves: 12,
    setIncShelfCapacity: 500,
    crmSafetyMarginPct: 8,
    crmExtraBufferDays: 5,
    lowFeedThresholdKg: 50,
    quailHatcherDays: 14,
    quailHatchDays: 17,
    quailSlaughterDays: 38
};

export const state = {
    settings: { ...DEFAULT_SETTINGS },
    batches: {},
    archivedBatches: {},
    incubatorGrid: {},
    ledger: {},
    archivedLedger: {},
    monthlyClosings: {},
    financialCenter: {
        cumulativeBalance: 0,
        currentMonthRevenue: 0,
        currentMonthExpenses: 0
    },
    cashBox: 0,
    feedStock: 0,
    feedAvgCost: 0,
    freezerConfig: {},
    freezerStock: {},
    freezerLogs: {},
    equipment: {},
    flockData: {
        females: 0,
        males: 0,
        entryDate: '',
        initialAgeWeeks: 0
    },
    readyEggsStock: 0,
    tableEggsStock: 0,
    breedersLogs: {},
    breedersHistoryLogs: {},
    ui: {
        currentPage: 'dashboard',
        ledgerFilter: 'all',
        ledgerSearch: '',
        isDeleteLogMode: false,
        connected: false
    }
};

/**
 * إرجاع المعايير البيولوجية للطائر مع احترام تعديلات المستخدم في الإعدادات
 */
export function getBirdStandard(type = 'quail') {
    const base = DEFAULT_BIRD_STANDARDS[type] || DEFAULT_BIRD_STANDARDS.quail;
    if (type === 'quail') {
        return {
            ...base,
            hatcher: Number(state.settings.quailHatcherDays) || base.hatcher,
            hatch: Number(state.settings.quailHatchDays) || base.hatch,
            slaughter: Number(state.settings.quailSlaughterDays) || base.slaughter
        };
    }
    return { ...base };
}

/**
 * سعر الكيلو الفعلي للعلف (متوسط الشراء المرجح أو السعر المبرمج بالإعدادات)
 */
export function getEffectiveFeedPrice() {
    if (state.feedAvgCost > 0) return Number(state.feedAvgCost);
    return Number(state.settings.feedPrice) || 30;
}

/**
 * حساب الأجواز المتوقعة للـ CRM بنسبة أمان ذكية قابلة للتعديل
 */
export function calcCrmExpectedPairs(aliveBirds) {
    const alive = Math.max(0, Number(aliveBirds) || 0);
    const margin = Math.min(50, Math.max(0, Number(state.settings.crmSafetyMarginPct ?? 8)));
    const safeBirds = alive * (1 - margin / 100);
    return Math.max(0, Math.floor(safeBirds / 2));
}

/**
 * حساب العمر الحقيقي لقطيع الأمهات بالأسابيع (العمر عند الدخول + المدة منذ الدخول)
 */
export function getTrueFlockAgeWeeks() {
    const initial = Number(state.flockData.initialAgeWeeks) || 0;
    if (!state.flockData.entryDate) return initial;
    const entry = new Date(state.flockData.entryDate);
    if (isNaN(entry.getTime())) return initial;
    const diffMs = Date.now() - entry.getTime();
    const weeksSince = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7)));
    return initial + weeksSince;
}

/**
 * أدوات تنسيق الأرقام والتواريخ
 */
export function fmtMoney(n) {
    const val = Number(n) || 0;
    return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtNum(n, decimals = 0) {
    const val = Number(n) || 0;
    return val.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

export function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function todayISO() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowLocalInput() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toLocalInput(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    if (isNaN(d.getTime())) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTimeAr(isoString) {
    if (!isoString) return '-';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '-';
    const pad = (x) => String(x).padStart(2, '0');
    const datePart = d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' });
    return `${datePart} (${pad(d.getHours())}:${pad(d.getMinutes())})`;
}

export function formatTimeLeftAr(hours) {
    const absH = Math.abs(hours);
    const d = Math.floor(absH / 24);
    const h = Math.floor(absH % 24);
    if (d > 0 && h > 0) return `${d} يوم و ${h} ساعة`;
    if (d > 0) return `${d} يوم`;
    return `${h} ساعة`;
}
