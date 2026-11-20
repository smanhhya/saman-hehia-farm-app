// www/js/core/ui.js
// إدارة التنقل، النوافذ المنبثقة، الوضع الليلي، زر الرجوع لأندرويد، وقفل الأزرار

import { state } from './state.js';

let toastTimer = null;
const activeLocks = new Set();

/**
 * قفل أي عملية غير متزامنة لمنع الضغط المزدوج وتكرار التسجيل
 */
export async function withActionLock(lockKey, asyncFn, loadingText = null) {
    if (activeLocks.has(lockKey)) return;
    activeLocks.add(lockKey);
    if (loadingText) toggleLoader(true, loadingText);
    try {
        return await asyncFn();
    } catch (err) {
        console.error(`[ActionError:${lockKey}]`, err);
        if (String(err?.message || '').startsWith('INSUFFICIENT_BALANCE:')) {
            showToast('الرصيد المتاح لا يكفي لإتمام العملية!', true);
        } else {
            showToast('حدث خطأ غير متوقع، تأكد من الاتصال بالإنترنت', true);
        }
    } finally {
        activeLocks.delete(lockKey);
        if (loadingText) toggleLoader(false);
    }
}

export function toggleLoader(show, message = 'جاري التنفيذ...') {
    const el = document.getElementById('globalLoader');
    const txt = document.getElementById('globalLoaderText');
    if (!el) return;
    if (txt) txt.textContent = message;
    el.style.display = show ? 'flex' : 'none';
}

export function showToast(msg, isError = false, duration = 3200) {
    const el = document.getElementById('toast');
    if (!el) return;
    if (toastTimer) clearTimeout(toastTimer);
    el.textContent = msg;
    el.className = isError ? 'toast-show toast-error' : 'toast-show toast-success';
    toastTimer = setTimeout(() => {
        el.className = '';
    }, duration);
}

export function switchPage(pageId) {
    document.querySelectorAll('.page-view').forEach((p) => p.classList.remove('active'));
    const target = document.getElementById(pageId);
    if (target) target.classList.add('active');

    state.ui.currentPage = pageId;

    // Update active state on sidebar & bottom nav
    document.querySelectorAll('[data-page]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-page') === pageId);
    });

    // Highlight "المزيد" on mobile if the page belongs to the More menu
    const morePages = ['freezer', 'finance', 'reports', 'inventory', 'settingsPage'];
    const moreBtn = document.getElementById('mobileMoreBtn');
    if (moreBtn) {
        moreBtn.classList.toggle('active', morePages.includes(pageId));
    }

    // Close mobile more drawer & fab menu
    closeModal('modalMoreMenu');
    const fabMenu = document.getElementById('fabMenu');
    if (fabMenu) fabMenu.classList.remove('active');

    // Scroll to top cleanly
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('open');
    el.style.display = 'flex';
}

export function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open');
    el.style.display = 'none';
}

export function closeTopModal() {
    const openModals = Array.from(document.querySelectorAll('.modal-overlay.open'));
    if (openModals.length > 0) {
        const top = openModals[openModals.length - 1];
        top.classList.remove('open');
        top.style.display = 'none';
        return true;
    }
    return false;
}

export function toggleFab() {
    const fab = document.getElementById('fabMenu');
    const btn = document.getElementById('fabMainBtn');
    if (!fab) return;
    const isActive = fab.classList.toggle('active');
    if (btn) btn.classList.toggle('rotated', isActive);
}

/**
 * توحيد مفتاح الثيم (saman_theme) واللون الأساسي (saman_accent)
 */
export function initThemeSystem() {
    const theme = localStorage.getItem('saman_theme') || localStorage.getItem('erp_theme') || 'light';
    const accent = localStorage.getItem('saman_accent') || localStorage.getItem('erp_primary_color') || '#2563eb';
    applyTheme(theme, false);
    applyAccentColor(accent, false);
}

export function applyTheme(mode, notify = true) {
    const safeMode = mode === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', safeMode);
    localStorage.setItem('saman_theme', safeMode);

    const icon = document.getElementById('themeIcon');
    if (icon) {
        icon.className = safeMode === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        icon.style.color = safeMode === 'dark' ? '#f59e0b' : 'var(--text-primary)';
    }

    document.querySelectorAll('.theme-option').forEach((el) => {
        el.classList.toggle('active', el.dataset.themeMode === safeMode);
    });

    if (notify) {
        showToast(safeMode === 'dark' ? 'تم تفعيل الوضع الليلي 🌙' : 'تم تفعيل الوضع الفاتح ☀️');
    }
}

export function toggleAppTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark', true);
}

export function applyAccentColor(hex, notify = true) {
    document.documentElement.style.setProperty('--primary', hex);
    localStorage.setItem('saman_accent', hex);

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', hex);

    document.querySelectorAll('.color-circle').forEach((el) => {
        el.classList.toggle('active', el.dataset.color === hex);
    });

    if (notify) showToast('تم تحديث اللون الأساسي بنجاح 🎨');
}

export function updateConnectionBadge(isConnected) {
    state.ui.connected = isConnected;
    const dot = document.getElementById('connStatusDot');
    const label = document.getElementById('connStatusText');
    if (dot) {
        dot.style.background = isConnected ? 'var(--success)' : 'var(--danger)';
        dot.title = isConnected ? 'متصل بالسحابة لحظياً' : 'غير متصل بالإنترنت';
    }
    if (label) {
        label.textContent = isConnected ? 'متصل' : 'أوفلاين';
    }
}

/**
 * تهيئة اختصارات الكيبورد، الضغط خارج المودال، وزر الرجوع في أندرويد (Capacitor)
 */
export function initGlobalInteractions(onOpenCommandPalette) {
    // إغلاق المودال عند الضغط على الخلفية
    document.addEventListener('click', (e) => {
        if (e.target.classList && e.target.classList.contains('modal-overlay') && e.target.classList.contains('open')) {
            e.target.classList.remove('open');
            e.target.style.display = 'none';
        }
        // إغلاق قائمة الزر العائم لو ضغط المستخدم خارجها
        const fabWrap = document.querySelector('.fab-container');
        const fabMenu = document.getElementById('fabMenu');
        if (fabMenu && fabMenu.classList.contains('active') && fabWrap && !fabWrap.contains(e.target)) {
            fabMenu.classList.remove('active');
            document.getElementById('fabMainBtn')?.classList.remove('rotated');
        }
    });

    // اختصارات Ctrl+K و ESC
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (onOpenCommandPalette) onOpenCommandPalette();
        } else if (e.key === 'Escape') {
            closeTopModal();
        }
    });

    // دعم زر الرجوع الأصلي في تطبيق الأندرويد (Capacitor App Plugin)
    try {
        const CapApp = window.Capacitor?.Plugins?.App;
        if (CapApp && typeof CapApp.addListener === 'function') {
            CapApp.addListener('backButton', ({ canGoBack }) => {
                if (closeTopModal()) return;
                if (state.ui.currentPage !== 'dashboard') {
                    switchPage('dashboard');
                    return;
                }
                if (canGoBack) {
                    window.history.back();
                } else {
                    CapApp.exitApp();
                }
            });
        }
    } catch (err) {
        console.log('Running in web mode (Capacitor App plugin inactive)');
    }
}
