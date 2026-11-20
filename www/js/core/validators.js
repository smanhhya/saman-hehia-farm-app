// www/js/core/validators.js
// طبقة التحقق الصارم من المدخلات والحماية من XSS و NaN

import { showToast } from './ui.js';

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function parsePositiveNumber(raw, fieldName, { allowZero = false, isInt = false } = {}) {
    if (raw === '' || raw === null || raw === undefined) {
        if (allowZero) return 0;
        showToast(`برجاء إدخال ${fieldName}`, true);
        return null;
    }
    const num = isInt ? parseInt(raw, 10) : parseFloat(raw);
    if (isNaN(num) || (!allowZero && num <= 0) || (allowZero && num < 0)) {
        showToast(`قيمة غير صحيحة في حقل "${fieldName}"`, true);
        return null;
    }
    return num;
}

export function parseRequiredText(raw, fieldName) {
    const val = (raw || '').trim();
    if (!val) {
        showToast(`حقل "${fieldName}" مطلوب`, true);
        return null;
    }
    return val;
}
