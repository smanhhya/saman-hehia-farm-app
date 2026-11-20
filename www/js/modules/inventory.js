// www/js/modules/inventory.js
// إدارة جرد المعدات والأصول الثابتة (منفصل تماماً عن الأرباح التشغيلية)

import { db, ref, set, update, remove, atomicAdjust } from '../config/firebase.js';
import { state, fmtMoney, fmtNum, round2 } from '../core/state.js';
import { showToast, openModal, closeModal, withActionLock } from '../core/ui.js';
import { parsePositiveNumber, parseRequiredText, escapeHtml } from '../core/validators.js';

export function renderInventoryList() {
    const listEl = document.getElementById('inventoryList');
    const dashTotalEl = document.getElementById('dashInventoryTotal');
    const pageTotalEl = document.getElementById('inventoryTotalValue');

    let totalCapital = 0;
    const entries = Object.entries(state.equipment || {});

    entries.forEach(([, item]) => {
        totalCapital += (Number(item.qty) || 0) * (Number(item.price) || 0);
    });
    totalCapital = round2(totalCapital);

    if (dashTotalEl) dashTotalEl.textContent = fmtMoney(totalCapital);
    if (pageTotalEl) pageTotalEl.textContent = `${fmtMoney(totalCapital)} ج.م`;

    if (!listEl) return;

    if (entries.length === 0) {
        listEl.innerHTML = '<div class="empty-state">لا توجد معدات مسجلة في الجرد حتى الآن.</div>';
        return;
    }

    listEl.innerHTML = entries.map(([id, item]) => {
        const qty = Number(item.qty) || 0;
        const price = Number(item.price) || 0;
        const subtotal = round2(qty * price);

        return `
        <div class="equipment-row">
            <div>
                <strong style="font-size:15px;">${escapeHtml(item.name)}</strong>
                <div class="sub-text">سعر الوحدة: ${fmtMoney(price)} ج | الإجمالي: <b style="color:var(--info);">${fmtMoney(subtotal)} ج.م</b></div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <div class="qty-stepper">
                    <button onclick="updateInventoryItemQty('${id}', -1)" title="هالك / نقص">-</button>
                    <span>${fmtNum(qty)}</span>
                    <button onclick="updateInventoryItemQty('${id}', 1)" title="إضافة">+</button>
                </div>
                <button class="icon-btn-info" onclick="openEditInventoryModal('${id}')" title="تعديل"><i class="fas fa-pen"></i></button>
                <button class="icon-btn-danger" onclick="deleteInventoryItem('${id}')" title="حذف"><i class="fas fa-trash-alt"></i></button>
            </div>
        </div>`;
    }).join('');
}

export function openAddInventoryModal() {
    document.getElementById('invEditId').value = '';
    document.getElementById('invModalTitle').textContent = '🛠️ إضافة صنف للجرد (معدات)';
    document.getElementById('invItemName').value = '';
    document.getElementById('invItemQty').value = '';
    document.getElementById('invItemPrice').value = '';
    openModal('modalManageInventory');
}

export function openEditInventoryModal(id) {
    const item = state.equipment[id];
    if (!item) return;
    document.getElementById('invEditId').value = id;
    document.getElementById('invModalTitle').textContent = '✏️ تعديل بيانات المعدة';
    document.getElementById('invItemName').value = item.name || '';
    document.getElementById('invItemQty').value = item.qty || 0;
    document.getElementById('invItemPrice').value = item.price || 0;
    openModal('modalManageInventory');
}

export async function addOrUpdateInventoryItem() {
    await withActionLock('saveInv', async () => {
        const editId = document.getElementById('invEditId')?.value;
        const name = parseRequiredText(document.getElementById('invItemName')?.value, 'اسم المعدة');
        const qty = parsePositiveNumber(document.getElementById('invItemQty')?.value, 'العدد', { allowZero: true, isInt: true });
        const price = parsePositiveNumber(document.getElementById('invItemPrice')?.value, 'سعر الوحدة', { allowZero: true });

        if (!name || qty === null || price === null) return;

        const id = editId || ('eq_' + Date.now());
        await set(ref(db, `inventory/equipment/${id}`), { name, qty, price });

        closeModal('modalManageInventory');
        showToast(editId ? 'تم تحديث بيانات المعدة 🛠️' : 'تمت إضافة المعدة للجرد 🛠️');
    });
}

export async function updateInventoryItemQty(id, delta) {
    const item = state.equipment[id];
    if (!item) return;
    if ((Number(item.qty) || 0) + delta < 0) return showToast('لا يمكن أن يكون العدد بالسالب!', true);
    await atomicAdjust(`inventory/equipment/${id}/qty`, delta, { allowNegative: false, decimals: 0 });
    showToast(delta > 0 ? 'تمت الزيادة 📈' : 'تم تسجيل الهالك 📉');
}

export async function deleteInventoryItem(id) {
    const item = state.equipment[id];
    if (!item) return;
    if (!confirm(`حذف "${item.name}" نهائياً من الجرد؟`)) return;
    await remove(ref(db, `inventory/equipment/${id}`));
    showToast('تم الحذف من الجرد');
}
