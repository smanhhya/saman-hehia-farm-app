// www/js/app.js — نسخة مُصلّحة تعمل مباشرة على ملفاتك الموجودة

async function loadModuleSafe(path) {
    try {
        return await import(path);
    } catch (err) {
        throw new Error(`مشكلة في الملف (${path}): ${err?.message || err}`);
    }
}

function showBootError(msg) {
    const connText = document.getElementById('connStatusText');
    const connDot = document.getElementById('connStatusDot');
    if (connText) connText.textContent = 'خطأ تحميل';
    if (connDot) connDot.style.background = '#dc2626';

    const alertsEl = document.getElementById('alertsContainer');
    if (alertsEl) {
        alertsEl.innerHTML = `
            <div class="alert-item alert-danger" style="direction:rtl; text-align:right;">
                <b>❌ توقف التشغيل بسبب خطأ محدد:</b><br>
                <div style="margin:8px 0; font-family:monospace; font-size:12px; direction:ltr; text-align:left; background:rgba(0,0,0,0.08); padding:8px; border-radius:8px; word-break:break-all;">${msg}</div>
                <button class="btn btn-primary btn-sm" onclick="window.location.reload()">🔄 إعادة المحاولة</button>
            </div>`;
    }
}

async function bootApp() {
    try {
        const [
            fb, st, uiMod, valMod,
            breeders, incubator, rearing, freezer,
            finance, reports, inventory, settings
        ] = await Promise.all([
            loadModuleSafe('./config/firebase.js'),
            loadModuleSafe('./core/state.js'),
            loadModuleSafe('./core/ui.js'),
            loadModuleSafe('./core/validators.js'),
            loadModuleSafe('./modules/breeders.js'),
            loadModuleSafe('./modules/incubator.js'),
            loadModuleSafe('./modules/rearing.js'),
            loadModuleSafe('./modules/freezer.js'),
            loadModuleSafe('./modules/finance.js'),
            loadModuleSafe('./modules/reports.js'),
            loadModuleSafe('./modules/inventory.js'),
            loadModuleSafe('./modules/settings.js')
        ]);

        const { db, ref, set, onValue } = fb;
        const {
            state, DEFAULT_SETTINGS, getBirdStandard, fmtNum,
            formatDateTimeAr, formatTimeLeftAr, getTrueFlockAgeWeeks
        } = st;
        const {
            switchPage, openModal, closeModal, showToast, toggleFab,
            initThemeSystem, applyTheme, toggleAppTheme, applyAccentColor,
            initGlobalInteractions, updateConnectionBadge
        } = uiMod;
        const { escapeHtml } = valMod;

        function renderBatchesAndAlerts() {
            const ui = {
                inc: document.getElementById('incubatorList'),
                rear: document.getElementById('rearingList'),
                slaugh: document.getElementById('slaughterList'),
                alerts: document.getElementById('alertsContainer'),
                dSelect: document.getElementById('dBatch'),
                eSelect: document.getElementById('eBatch')
            };

            if (ui.inc) ui.inc.innerHTML = '';
            if (ui.rear) ui.rear.innerHTML = '';
            if (ui.slaugh) ui.slaugh.innerHTML = '';
            if (ui.dSelect) ui.dSelect.innerHTML = '';
            if (ui.eSelect) ui.eSelect.innerHTML = '<option value="general">مصروف عام (غير محمل على دفعة)</option>';

            const now = new Date();
            const alertsList = [];
            let totalEggs = 0;
            let totalChicks = 0;
            let incGroups = { quail: '', chicken: '', turkey: '' };

            const lowFeedThreshold = Number(state.settings.lowFeedThresholdKg) || 50;
            if (state.feedStock < lowFeedThreshold) {
                alertsList.push({
                    level: 'danger',
                    html: `<i class="fas fa-triangle-exclamation"></i> <b>نقص علف عاجل:</b> الرصيد بالمخزن <b>${fmtNum(state.feedStock, 1)} كجم</b> فقط (الحد الآمن ${lowFeedThreshold} كجم).`
                });
            }

            const flockTotal = (Number(state.flockData.females) || 0) + (Number(state.flockData.males) || 0);
            const trueFlockAge = getTrueFlockAgeWeeks();
            if (flockTotal > 0 && trueFlockAge >= 28) {
                alertsList.push({
                    level: 'warning',
                    html: `<i class="fas fa-venus-mars"></i> <b>قطيع الأمهات (${trueFlockAge} أسبوع):</b> تخطى 28 أسبوع — يُنصح بتجهيز قطيع إحلال.`
                });
            }

            freezer.getOldFreezerAlerts().forEach((a) => {
                alertsList.push({
                    level: 'danger',
                    html: `<i class="fas fa-snowflake"></i> <b>بضاعة قديمة بالفريزر:</b> دفعة <b>${escapeHtml(a.batchName)}</b> متبقي منها ${a.remainingCount} وحدة منذ <b>${a.daysOld} يوم</b>!`
                });
            });

            const sortedEntries = Object.entries(state.batches || {})
                .sort(([, a], [, b]) => (b.order || 0) - (a.order || 0));

            sortedEntries.forEach(([id, b]) => {
                const bType = b.birdType || 'quail';
                const std = getBirdStandard(bType);

                if (b.status !== 'completed' && ui.eSelect) {
                    ui.eSelect.innerHTML += `<option value="${id}">${escapeHtml(b.name)} (${std.name})</option>`;
                }

                const hoursToHatcher = b.hatcherDate ? (new Date(b.hatcherDate) - now) / 3600000 : 999;
                const hoursToHatch = b.hatchDate ? (new Date(b.hatchDate) - now) / 3600000 : 999;
                const hoursToSlaughter = b.rearDate ? (new Date(b.rearDate) - now) / 3600000 : 999;

                if (b.status === 'incubator' || b.status === 'hatcher') {
                    totalEggs += Number(b.initialEggs) || 0;
                    const daysIn = b.insertDate ? Math.max(0, (now - new Date(b.insertDate)) / 86400000) : 0;
                    const totalIncDays = std.hatch || 17;
                    const pct = Math.min(100, Math.max(0, Math.round((daysIn / totalIncDays) * 100)));

                    let badge = '';
                    let actionBtn = '';
                    let cardBanner = '';

                    if (b.status === 'incubator') {
                        badge = '<span class="badge" style="background:var(--info);">حضانة</span>';
                        actionBtn = `<button class="btn btn-info btn-sm" onclick="updateStage('${id}','hatcher')">نقل للمفقس 📥</button>`;

                        if (hoursToHatcher > 0 && hoursToHatcher <= 48) {
                            alertsList.push({ level: 'warning', html: `⏳ <b>${escapeHtml(b.name)}</b> متبقي <b>${formatTimeLeftAr(hoursToHatcher)}</b> للنقل للمفقس.` });
                        } else if (hoursToHatcher <= 0 && hoursToHatcher > -24) {
                            alertsList.push({ level: 'info', html: `🔔 <b>${escapeHtml(b.name)}</b> جاهزة الآن للنقل للمفقس!` });
                            cardBanner = '<div class="card-banner banner-info">🔔 حان موعد النقل للمفقس وإيقاف التقليب!</div>';
                        } else if (hoursToHatcher <= -24) {
                            alertsList.push({ level: 'danger', html: `🚨 <b>تأخير خطير:</b> الدفعة <b>${escapeHtml(b.name)}</b> تأخرت عن المفقس <b>${formatTimeLeftAr(hoursToHatcher)}</b>!` });
                            cardBanner = '<div class="card-banner banner-danger">🚨 تأخير خطير في النقل للمفقس!</div>';
                        }
                    } else {
                        badge = '<span class="badge" style="background:var(--primary);">مفقس</span>';
                        actionBtn = `<button class="btn btn-primary btn-sm" onclick="promptHatch('${id}')">إتمام الفقس 🐣</button>`;

                        if (hoursToHatch > 0 && hoursToHatch <= 48) {
                            alertsList.push({ level: 'info', html: `🐣 <b>${escapeHtml(b.name)}</b> متبقي <b>${formatTimeLeftAr(hoursToHatch)}</b> على الفقس.` });
                        } else if (hoursToHatch <= 0 && hoursToHatch > -24) {
                            alertsList.push({ level: 'success', html: `🐣 <b>${escapeHtml(b.name)}</b> جاهزة للفقس الآن!` });
                            cardBanner = '<div class="card-banner banner-success">🐣 حان موعد خروج الكتاكيت الآن!</div>';
                        } else if (hoursToHatch <= -24) {
                            alertsList.push({ level: 'danger', html: `🚨 <b>تأخير فقس:</b> الدفعة <b>${escapeHtml(b.name)}</b> تجاوزت موعد الفقس بـ <b>${formatTimeLeftAr(hoursToHatch)}</b>!` });
                            cardBanner = '<div class="card-banner banner-danger">🚨 تأخير خطير في إخراج الفقس!</div>';
                        }
                    }

                    const cardHtml = `
                    <div class="batch-card stage-${b.status}">
                        ${cardBanner}
                        <div class="batch-top">
                            <div style="display:flex; align-items:center; gap:10px;">
                                <span style="font-size:24px;">${std.icon}</span>
                                <div>
                                    <strong style="font-size:17px;">${escapeHtml(b.name)}</strong>
                                    <div class="sub-text">${std.name} • مرّ ${daysIn.toFixed(1)} من ${totalIncDays} يوم</div>
                                </div>
                            </div>
                            ${badge}
                        </div>
                        <div class="progress-wrap">
                            <div class="progress-bar" style="width:${pct}%; background:${b.status === 'hatcher' ? 'var(--primary)' : 'var(--info)'};"></div>
                        </div>
                        <div class="dates-grid">
                            <div><span>دخول الماكينة</span><b>${formatDateTimeAr(b.insertDate)}</b></div>
                            <div><span>نزول المفقس</span><b class="text-info">${formatDateTimeAr(b.hatcherDate)}</b></div>
                            <div><span>موعد الفقس</span><b class="text-success">${formatDateTimeAr(b.hatchDate)}</b></div>
                            <div><span>الذبح المتوقع</span><b class="text-danger">${formatDateTimeAr(b.rearDate)}</b></div>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin:12px 0;">
                            <span>البيض المتاح: <strong style="color:var(--primary); font-size:18px;">${fmtNum(b.initialEggs)}</strong></span>
                            <button class="btn-chip" onclick="promptDirectLiquidation('${id}')"><i class="fas fa-hand-holding-dollar"></i> بيع كتاكيت/تصفية</button>
                        </div>
                        <div class="batch-actions">
                            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                <button class="act-btn" onclick="moveBatchUp('${id}')" title="أعلى">⬆️</button>
                                <button class="act-btn" onclick="moveBatchDown('${id}')" title="أسفل">⬇️</button>
                                <button class="act-btn" onclick="openSellEggsModal('${id}')" title="بيع بيض" style="color:var(--warning);"><i class="fas fa-egg"></i></button>
                                <button class="act-btn" onclick="openEditBatch('${id}')" title="تعديل" style="color:var(--info);"><i class="fas fa-pen"></i></button>
                                <button class="act-btn" onclick="deleteBatch('${id}')" title="حذف" style="color:var(--danger);"><i class="fas fa-trash"></i></button>
                            </div>
                            <div>${actionBtn}</div>
                        </div>
                    </div>`;

                    if (bType === 'quail') incGroups.quail += cardHtml;
                    else if (bType === 'turkey') incGroups.turkey += cardHtml;
                    else incGroups.chicken += cardHtml;
                } else if (b.status === 'rearing') {
                    const hatched = Number(b.hatchedChicks) || 0;
                    const dead = Number(b.totalDead) || 0;
                    const alive = Math.max(0, hatched - dead);
                    totalChicks += alive;

                    const age = b.hatchDate ? Math.max(1, Math.floor((now - new Date(b.hatchDate)) / 86400000)) : 1;
                    const slAge = Number(b.slaughterAge) || std.slaughter;
                    const pct = Math.min(100, Math.max(0, Math.round((age / slAge) * 100)));
                    const mortPct = hatched > 0 ? ((dead / hatched) * 100).toFixed(1) : '0.0';

                    if (ui.dSelect) {
                        ui.dSelect.innerHTML += `<option value="${id}">${escapeHtml(b.name)} (عمر ${age} يوم | متبقي ${alive})</option>`;
                    }

                    if (hoursToSlaughter > 0 && hoursToSlaughter <= 72) {
                        alertsList.push({ level: 'warning', html: `🔪 <b>${escapeHtml(b.name)}</b> متبقي <b>${formatTimeLeftAr(hoursToSlaughter)}</b> على موعد الذبح.` });
                    } else if (hoursToSlaughter <= 0 && hoursToSlaughter > -48) {
                        alertsList.push({ level: 'danger', html: `⏳ <b>${escapeHtml(b.name)}</b> بلغت عمر ${age} يوم — جاهزة للذبح الآن!` });
                    } else if (hoursToSlaughter <= -48) {
                        alertsList.push({ level: 'danger', html: `🚨 <b>استهلاك علف زائد:</b> <b>${escapeHtml(b.name)}</b> تخطت موعد الذبح بـ <b>${formatTimeLeftAr(hoursToSlaughter)}</b>!` });
                    }

                    if (ui.rear) {
                        ui.rear.innerHTML += `
                        <div class="batch-card stage-rearing">
                            <div class="batch-top">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <span style="font-size:24px;">${std.icon}</span>
                                    <div>
                                        <strong style="font-size:17px;">${escapeHtml(b.name)}</strong>
                                        <div class="sub-text">فقس: ${b.hatchRate || 0}% • CRM متوقع: <b>${fmtNum(b.crmExpectedPairs || 0)} جوز</b></div>
                                    </div>
                                </div>
                                <span class="badge" style="background:var(--warning); color:#111;">عمر ${age}/${slAge} يوم</span>
                            </div>
                            <div class="progress-wrap">
                                <div class="progress-bar" style="width:${pct}%; background:${pct >= 95 ? 'var(--danger)' : 'var(--warning)'};"></div>
                            </div>
                            <div class="grid-3" style="margin:12px 0;">
                                <div class="mini-kpi"><span>متبقي حي</span><strong class="text-primary">${fmtNum(alive)}</strong></div>
                                <div class="mini-kpi"><span>نافق (${mortPct}%)</span><strong class="text-danger">${fmtNum(dead)}</strong></div>
                                <div class="mini-kpi"><span>علف مستهلك</span><strong>${fmtNum(b.totalFeed || 0, 1)} ك</strong></div>
                            </div>
                            <div class="dates-grid">
                                <div><span>بداية التربية</span><b>${formatDateTimeAr(b.hatchDate)}</b></div>
                                <div><span>موعد الذبح</span><b class="text-danger">${formatDateTimeAr(b.rearDate)}</b></div>
                            </div>
                            <div class="batch-actions">
                                <div style="display:flex; gap:6px;">
                                    <button class="act-btn" onclick="openDailyRearingModal('${id}')" title="علف/نافق" style="color:var(--warning);"><i class="fas fa-clipboard-list"></i></button>
                                    <button class="act-btn" onclick="openBatchReportFor('${id}')" title="تقرير التكلفة P&L" style="color:var(--primary);"><i class="fas fa-chart-bar"></i></button>
                                    <button class="act-btn" onclick="openEditBatch('${id}')" title="تعديل" style="color:var(--info);"><i class="fas fa-pen"></i></button>
                                    <button class="act-btn" onclick="deleteBatch('${id}')" title="حذف" style="color:var(--danger);"><i class="fas fa-trash"></i></button>
                                </div>
                                <div style="display:flex; gap:6px;">
                                    <button class="btn btn-info btn-sm" onclick="openDailyGuide('${id}')"><i class="fas fa-clipboard-check"></i> مهام</button>
                                    <button class="btn btn-danger btn-sm" onclick="updateStage('${id}','slaughter')">للذبح 🔪</button>
                                </div>
                            </div>
                        </div>`;
                    }
                } else if (b.status === 'slaughter') {
                    const alive = Math.max(0, (Number(b.hatchedChicks) || 0) - (Number(b.totalDead) || 0));
                    if (ui.slaugh) {
                        ui.slaugh.innerHTML += `
                        <div class="batch-card stage-slaughter">
                            <div class="batch-top">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <span style="font-size:24px;">${std.icon}</span>
                                    <div>
                                        <strong style="font-size:17px;">${escapeHtml(b.name)}</strong>
                                        <div class="sub-text">${std.name} • جاهز للتجهيز: <b>${fmtNum(alive)} طائر</b></div>
                                    </div>
                                </div>
                                <span class="badge" style="background:var(--danger);">قيد الذبح</span>
                            </div>
                            <div class="batch-actions">
                                <div style="display:flex; gap:6px;">
                                    <button class="act-btn" onclick="openBatchReportFor('${id}')" title="تقرير التكلفة" style="color:var(--primary);"><i class="fas fa-chart-bar"></i></button>
                                    <button class="act-btn" onclick="promptDirectLiquidation('${id}')" title="بيع صاحي/تصفية خارج الفريزر" style="color:var(--success);"><i class="fas fa-hand-holding-dollar"></i> بيع مباشر</button>
                                </div>
                                <div style="display:flex; gap:6px;">
                                    <button class="btn btn-warning btn-sm" onclick="updateStage('${id}','rearing')">↩️ تراجع</button>
                                    <button class="btn btn-success btn-sm" onclick="promptClassify('${id}')">تصنيف للفريزر ❄️</button>
                                </div>
                            </div>
                        </div>`;
                    }
                }
            });

            if (ui.inc) {
                if (incGroups.quail) ui.inc.innerHTML += `<div class="section-pill pill-info"><i class="fas fa-dove"></i> قسم تفريخ السمان</div>` + incGroups.quail;
                if (incGroups.chicken) ui.inc.innerHTML += `<div class="section-pill pill-warn"><i class="fas fa-kiwi-bird"></i> قسم تفريخ الدواجن</div>` + incGroups.chicken;
                if (incGroups.turkey) ui.inc.innerHTML += `<div class="section-pill pill-danger"><i class="fas fa-feather-pointed"></i> قسم تفريخ الرومي</div>` + incGroups.turkey;
                if (!ui.inc.innerHTML) ui.inc.innerHTML = '<div class="empty-state">لا توجد دفعات في المفرخ حالياً.</div>';
            }
            if (ui.rear && !ui.rear.innerHTML) ui.rear.innerHTML = '<div class="empty-state">لا توجد دفعات في عنابر التربية حالياً.</div>';
            if (ui.slaugh && !ui.slaugh.innerHTML) ui.slaugh.innerHTML = '<div class="empty-state">لا توجد دفعات قيد الذبح حالياً.</div>';

            const dashEggs = document.getElementById('dashEggs');
            const dashChicks = document.getElementById('dashChicks');
            if (dashEggs) dashEggs.textContent = fmtNum(totalEggs);
            if (dashChicks) dashChicks.textContent = fmtNum(totalChicks);

            if (ui.alerts) {
                ui.alerts.innerHTML = alertsList.length === 0
                    ? '<div class="alert-item alert-success">✅ المزرعة مستقرة تماماً — لا توجد تنبيهات عاجلة حالياً.</div>'
                    : alertsList.map((a) => `<div class="alert-item alert-${a.level}">${a.html}</div>`).join('');
            }
            reports.populateReportSelector();
        }

        const sysCmds = [
            { title: 'لوحة القيادة الرئيسية', icon: 'fas fa-chart-pie', action: () => switchPage('dashboard') },
            { title: 'إدارة قطيع الأمهات والمفرخ', icon: 'fas fa-venus-mars', action: () => switchPage('breeders') },
            { title: 'إدارة التفريخ والمفقس', icon: 'fas fa-temperature-half', action: () => switchPage('incubator') },
            { title: 'عنابر التربية والذبح', icon: 'fas fa-kiwi-bird', action: () => switchPage('rearing') },
            { title: 'المخزون والفريزر (FIFO)', icon: 'fas fa-snowflake', action: () => switchPage('freezer') },
            { title: 'المركز المالي والتقفيل', icon: 'fas fa-wallet', action: () => switchPage('finance') },
            { title: 'تقارير ربحية الدفعات (P&L)', icon: 'fas fa-chart-line', action: () => switchPage('reports') },
            { title: 'جرد المعدات والأصول', icon: 'fas fa-boxes', action: () => switchPage('inventory') },
            { title: 'مركز التحكم والإعدادات', icon: 'fas fa-sliders-h', action: () => switchPage('settingsPage') },
            { title: '➕ إضافة دفعة تفريخ جديدة', icon: 'fas fa-plus-circle', action: () => incubator.openNewBatchModal() },
            { title: '📝 تسجيل علف/نافق يومي (تربية)', icon: 'fas fa-clipboard-list', action: () => rearing.openDailyRearingModal() },
            { title: '🥚 فرز بيض الأمهات اليومي', icon: 'fas fa-egg', action: () => breeders.openTriageModal() },
            { title: '🌾 توريد علف جديد للمخزن', icon: 'fas fa-truck-loading', action: () => finance.openBuyFeedModal() },
            { title: '🛒 فاتورة بيع سريع من الفريزر', icon: 'fas fa-shopping-cart', action: () => freezer.openSaleModal() },
            { title: '🔄 مزامنة دفعات التربية مع الـ CRM', icon: 'fas fa-rotate', action: () => rearing.syncLegacyBatchesToCRM() },
            { title: '📥 تحميل نسخة احتياطية JSON', icon: 'fas fa-download', action: () => settings.exportFullBackup() }
        ];

        function openCommandPalette() {
            openModal('commandPalette');
            const inp = document.getElementById('cmdInput');
            if (inp) {
                inp.value = '';
                setTimeout(() => inp.focus(), 60);
            }
            renderCmdResults('');
        }

        function renderCmdResults(query) {
            const c = document.getElementById('cmdResults');
            if (!c) return;
            const q = (query || '').trim().toLowerCase();
            const list = sysCmds.filter((cmd) => cmd.title.toLowerCase().includes(q));
            if (list.length === 0) {
                c.innerHTML = '<div class="empty-state">لا توجد أوامر مطابقة</div>';
                return;
            }
            c.innerHTML = '';
            list.forEach((cmd) => {
                const div = document.createElement('div');
                div.className = 'cmd-item';
                div.innerHTML = `<i class="${cmd.icon}"></i><span>${cmd.title}</span>`;
                div.onclick = () => {
                    closeModal('commandPalette');
                    cmd.action();
                };
                c.appendChild(div);
            });
        }

        Object.assign(window, {
            switchPage, openModal, closeModal, showToast, toggleFab, toggleAppTheme,
            setThemeMode: (mode) => applyTheme(mode, true),
            setPrimaryColor: (hex) => applyAccentColor(hex, true),
            openCommandPalette,

            openFlockSetupModal: breeders.openFlockSetupModal,
            updateFlockLedger: breeders.updateFlockLedger,
            openBreederDailyModal: breeders.openBreederDailyModal,
            saveBreederDailyLog: breeders.saveBreederDailyLog,
            openTriageModal: breeders.openTriageModal,
            toggleTriagePeriod: breeders.toggleTriagePeriod,
            processTriage: breeders.processTriage,
            openSellTableEggsModal: breeders.openSellTableEggsModal,
            calcTableEggsTotal: breeders.calcTableEggsTotal,
            confirmSellTableEggs: breeders.confirmSellTableEggs,
            openBreederGuide: breeders.openBreederGuide,

            openShelfSetup: incubator.openShelfSetup,
            toggleShelfInputs: incubator.toggleShelfInputs,
            calcShelfDist: incubator.calcShelfDist,
            loadIncubatorShelf: incubator.loadIncubatorShelf,
            emptyShelf: incubator.emptyShelf,
            openNewBatchModal: incubator.openNewBatchModal,
            autoCalcDates: incubator.autoCalcDates,
            saveNewBatch: incubator.saveNewBatch,
            openEditBatch: incubator.openEditBatch,
            syncEditSlaughterDate: incubator.syncEditSlaughterDate,
            saveEditBatch: incubator.saveEditBatch,
            updateStage: incubator.updateStage,
            deleteBatch: incubator.deleteBatch,
            openSellEggsModal: incubator.openSellEggsModal,
            calcSellEggsTotal: incubator.calcSellEggsTotal,
            confirmSellEggs: incubator.confirmSellEggs,
            moveBatchUp: (id) => incubator.moveBatchOrder(id, 'up'),
            moveBatchDown: (id) => incubator.moveBatchOrder(id, 'down'),

            promptHatch: rearing.promptHatch,
            syncHatchSlaughterDate: rearing.syncHatchSlaughterDate,
            moveToRearing: rearing.moveToRearing,
            openDailyRearingModal: rearing.openDailyRearingModal,
            saveDailyLog: rearing.saveDailyLog,
            syncLegacyBatchesToCRM: rearing.syncLegacyBatchesToCRM,
            openDailyGuide: rearing.openDailyGuide,

            openEditFreezerItem: freezer.openEditFreezerItem,
            saveEditFreezerItem: freezer.saveEditFreezerItem,
            addCategoryFromMaster: freezer.addCategoryFromMaster,
            deleteFreezerCategory: freezer.deleteFreezerCategory,
            promptClassify: freezer.promptClassify,
            updateClassifyCounter: freezer.updateClassifyCounter,
            finishSlaughter: freezer.finishSlaughter,
            openSaleModal: freezer.openSaleModal,
            onSaleGradeChange: freezer.onSaleGradeChange,
            calculateSaleTotal: freezer.calculateSaleTotal,
            processSale: freezer.processSale,
            toggleLogDeletion: freezer.toggleLogDeletion,
            deleteFreezerLog: freezer.deleteFreezerLog,

            editFeedStock: finance.editFeedStock,
            editCashBox: finance.editCashBox,
            openBuyFeedModal: finance.openBuyFeedModal,
            previewFeedUnitCost: finance.previewFeedUnitCost,
            buyFeed: finance.buyFeed,
            openExpenseModal: finance.openExpenseModal,
            saveManualTransaction: finance.saveManualTransaction,
            deleteTransaction: finance.deleteTransaction,
            filterLedger: finance.filterLedger,
            searchLedger: finance.searchLedger,
            promptDirectLiquidation: finance.promptDirectLiquidation,
            confirmArchiveBatch: finance.confirmArchiveBatch,
            closeMonth: finance.closeMonth,

            generateBatchReport: reports.generateBatchReport,
            openBatchReportFor: reports.openBatchReportFor,

            openAddInventoryModal: inventory.openAddInventoryModal,
            openEditInventoryModal: inventory.openEditInventoryModal,
            addOrUpdateInventoryItem: inventory.addOrUpdateInventoryItem,
            updateInventoryItemQty: inventory.updateInventoryItemQty,
            deleteInventoryItem: inventory.deleteInventoryItem,

            switchSettingsTab: settings.switchSettingsTab,
            filterSettingsSearch: settings.filterSettingsSearch,
            calcIncubatorTotalCap: settings.calcIncubatorTotalCap,
            saveSettings: settings.saveSettings,
            exportFullBackup: settings.exportFullBackup,
            triggerImportBackup: settings.triggerImportBackup,
            handleImportBackup: settings.handleImportBackup,
            resetSystem: settings.resetSystem
        });

        initThemeSystem();
        initGlobalInteractions(openCommandPalette);
        document.getElementById('cmdInput')?.addEventListener('input', (e) => renderCmdResults(e.target.value));

        onValue(ref(db, '.info/connected'), (snap) => updateConnectionBadge(Boolean(snap.val())));

        onValue(ref(db, 'settings'), (snap) => {
            state.settings = snap.exists() ? { ...DEFAULT_SETTINGS, ...snap.val() } : { ...DEFAULT_SETTINGS };
            settings.hydrateSettingsUI();
            incubator.renderIncubatorGrid();
            finance.renderFeedStockCard();
            renderBatchesAndAlerts();
        });

        onValue(ref(db, 'batches'), (snap) => {
            state.batches = snap.exists() ? snap.val() : {};
            renderBatchesAndAlerts();
            incubator.renderIncubatorGrid();
        });

        onValue(ref(db, 'archivedBatches'), (snap) => {
            state.archivedBatches = snap.exists() ? snap.val() : {};
            finance.renderArchivedBatches();
            reports.populateReportSelector();
        });

        onValue(ref(db, 'incubatorGrid'), (snap) => {
            state.incubatorGrid = snap.exists() ? snap.val() : {};
            incubator.renderIncubatorGrid();
        });

        onValue(ref(db, 'inventory/feedStock'), (snap) => {
            state.feedStock = snap.exists() ? parseFloat(snap.val()) || 0 : 0;
            finance.renderFeedStockCard();
            renderBatchesAndAlerts();
        });

        onValue(ref(db, 'inventory/feedAvgCost'), (snap) => {
            state.feedAvgCost = snap.exists() ? parseFloat(snap.val()) || 0 : 0;
            finance.renderFeedStockCard();
        });

        onValue(ref(db, 'inventory/freezerConfig'), async (snap) => {
            if (!snap.exists() || Object.keys(snap.val()).length === 0) {
                const defaults = {
                    royal: { name: 'رويال', price: 120, birdsPerUnit: 2 },
                    jumbo: { name: 'جامبو', price: 90, birdsPerUnit: 2 },
                    super: { name: 'سوبر', price: 80, birdsPerUnit: 2 }
                };
                await set(ref(db, 'inventory/freezerConfig'), defaults);
                await set(ref(db, 'inventory/freezerStock'), { royal: 0, jumbo: 0, super: 0 });
                return;
            }
            state.freezerConfig = snap.val();
            freezer.renderFreezerAll();
            reports.generateBatchReport();
        });

        onValue(ref(db, 'inventory/freezerStock'), (snap) => {
            state.freezerStock = snap.exists() ? snap.val() : {};
            freezer.renderFreezerAll();
        });

        onValue(ref(db, 'inventory/freezerLogs'), (snap) => {
            state.freezerLogs = snap.exists() ? snap.val() : {};
            freezer.renderFreezerLogs();
            renderBatchesAndAlerts();
        });

        onValue(ref(db, 'inventory/equipment'), (snap) => {
            state.equipment = snap.exists() ? snap.val() : {};
            inventory.renderInventoryList();
        });

        onValue(ref(db, 'inventory/flockData'), (snap) => {
            state.flockData = snap.exists()
                ? { females: 0, males: 0, entryDate: '', initialAgeWeeks: 0, ...snap.val() }
                : { females: 0, males: 0, entryDate: '', initialAgeWeeks: 0 };
            breeders.renderBreeders();
            renderBatchesAndAlerts();
        });

        onValue(ref(db, 'inventory/readyEggsStock'), (snap) => {
            state.readyEggsStock = snap.exists() ? parseInt(snap.val(), 10) || 0 : 0;
            breeders.renderBreeders();
        });

        onValue(ref(db, 'inventory/tableEggsStock'), (snap) => {
            state.tableEggsStock = snap.exists() ? parseInt(snap.val(), 10) || 0 : 0;
            breeders.renderBreeders();
        });

        onValue(ref(db, 'breedersLogs'), (snap) => {
            state.breedersLogs = snap.exists() ? snap.val() : {};
            breeders.renderBreeders();
        });

        onValue(ref(db, 'financialCenter'), (snap) => {
            state.financialCenter = snap.exists()
                ? { cumulativeBalance: 0, currentMonthRevenue: 0, currentMonthExpenses: 0, ...snap.val() }
                : { cumulativeBalance: 0, currentMonthRevenue: 0, currentMonthExpenses: 0 };
            finance.renderFinanceSummary();
        });

        onValue(ref(db, 'cashBox'), (snap) => {
            state.cashBox = snap.exists() ? parseFloat(snap.val()) || 0 : 0;
            finance.renderFinanceSummary();
        });

        onValue(ref(db, 'ledger'), (snap) => {
            state.ledger = snap.exists() ? snap.val() : {};
            finance.renderTransactionsList();
            reports.generateBatchReport();
        });

        onValue(ref(db, 'archivedLedger'), (snap) => {
            state.archivedLedger = snap.exists() ? snap.val() : {};
            reports.generateBatchReport();
        });

        onValue(ref(db, 'monthlyClosings'), (snap) => {
            state.monthlyClosings = snap.exists() ? snap.val() : {};
            finance.renderMonthlyClosingsHistory();
        });

        if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
            navigator.serviceWorker.register('./sw.js').then((reg) => reg.update().catch(() => {})).catch(() => {});
        }
    } catch (err) {
        console.error('[BootError]', err);
        showBootError(err?.message || String(err));
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp);
} else {
    bootApp();
}
