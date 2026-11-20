// www/js/config/firebase.js
// توحيد إصدار Firebase 10.12.0 للمشروعين (المزرعة RTDB + المبيعات CRM Firestore)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getDatabase,
    ref,
    set,
    get,
    push,
    update,
    remove,
    onValue,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
    getFirestore,
    doc,
    setDoc,
    getDoc,
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 1. قاعدة بيانات المزرعة الأساسية (Realtime Database)
const farmFirebaseConfig = {
    apiKey: "AIzaSyCVlbWLaLqYnQVsWgFPTe4PL38bWLTLyuU",
    authDomain: "sman-6512c.firebaseapp.com",
    databaseURL: "https://sman-6512c-default-rtdb.firebaseio.com",
    projectId: "sman-6512c",
    storageBucket: "sman-6512c.firebasestorage.app"
};

// 2. قاعدة بيانات المبيعات والعملاء (CRM Firestore)
const crmFirebaseConfig = {
    apiKey: "AIzaSyD7ZJP8n8fhMewPfEsTBANn0h9To_q15BY",
    authDomain: "sman-ca8f8.firebaseapp.com",
    projectId: "sman-ca8f8",
    storageBucket: "sman-ca8f8.firebasestorage.app",
    messagingSenderId: "538778803310",
    appId: "1:538778803310:web:5eeff42bae534375a21a7f"
};

const farmApp = initializeApp(farmFirebaseConfig);
const db = getDatabase(farmApp);

const crmApp = initializeApp(crmFirebaseConfig, "CRM_System");
const crmDb = getFirestore(crmApp);

/**
 * تعديل رقمي ذري (Atomic Transaction) يمنع تضارب الأجهزة ويمنع الرصيد السالب عند الحاجة
 * @param {string} path مسار الحقل في Realtime DB
 * @param {number} delta مقدار الزيادة (+) أو النقصان (-)
 * @param {object} options { allowNegative: boolean, decimals: number }
 */
export async function atomicAdjust(path, delta, options = {}) {
    const { allowNegative = false, decimals = 2 } = options;
    const targetRef = ref(db, path);
    const numDelta = Number(delta) || 0;

    const result = await runTransaction(targetRef, (currentValue) => {
        const current = parseFloat(currentValue) || 0;
        let next = current + numDelta;
        if (!allowNegative && next < 0) {
            // إلغاء المعاملة إذا كانت ستسبب رصيداً سالباً غير مسموح به
            return;
        }
        return Number(next.toFixed(decimals));
    });

    if (!result.committed) {
        throw new Error(`INSUFFICIENT_BALANCE:${path}`);
    }
    return result.snapshot.val();
}

/**
 * ترحيل أو تحديث دفعة في الـ CRM بأمان تام
 * - عند الإنشاء (isNew = true): يُنشئ الدفعة كاملة بـ stock/booked فارغين
 * - عند التحديث (isNew = false): يُحدّث المتاح المتوقع/الاسم فقط دون لمس حجوزات العملاء (booked)
 */
export async function syncBatchToCRM(batchId, data, isNew = false) {
    const batchDocRef = doc(crmDb, "inventory", "batches");
    if (isNew) {
        await setDoc(batchDocRef, {
            [batchId]: {
                name: data.name,
                isOpen: true,
                isVisible: true,
                expectedPairs: Math.max(0, Math.floor(data.expectedPairs || 0)),
                hatchDate: data.hatchDate,
                slaughterAge: data.slaughterAge,
                stock: {},
                booked: {}
            }
        }, { merge: true });
    } else {
        const safePatch = {};
        if (data.name !== undefined) safePatch.name = data.name;
        if (data.expectedPairs !== undefined) {
            safePatch.expectedPairs = Math.max(0, Math.floor(data.expectedPairs));
        }
        if (data.slaughterAge !== undefined) safePatch.slaughterAge = data.slaughterAge;
        if (data.isOpen !== undefined) safePatch.isOpen = data.isOpen;
        if (data.isVisible !== undefined) safePatch.isVisible = data.isVisible;

        if (Object.keys(safePatch).length > 0) {
            await setDoc(batchDocRef, { [batchId]: safePatch }, { merge: true });
        }
    }
}

export {
    db,
    ref,
    set,
    get,
    push,
    update,
    remove,
    onValue,
    runTransaction,
    crmDb,
    doc,
    setDoc,
    getDoc,
    updateDoc
};
