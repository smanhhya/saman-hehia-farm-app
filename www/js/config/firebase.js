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
 * تعديل رقمي ذري (Atomic Transaction) يمنع تضارب الأجهزة ويحمي من الرصيد السالب
 */
export async function atomicAdjust(path, delta, options = {}) {
    const { allowNegative = false, decimals = 2 } = options;
    const targetRef = ref(db, path);
    const numDelta = Number(delta) || 0;

    const result = await runTransaction(targetRef, (currentValue) => {
        const current = parseFloat(currentValue) || 0;
        const next = current + numDelta;
        if (!allowNegative && next < -0.0001) {
            return;
        }
        const safeNext = !allowNegative && next < 0 ? 0 : next;
        return Number(safeNext.toFixed(decimals));
    });

    if (!result.committed) {
        throw new Error(`INSUFFICIENT_BALANCE:${path}`);
    }
    return result.snapshot.val();
}

/**
 * ترحيل أو تحديث دفعة في الـ CRM بأمان تام مع دعم كامل لكل المزايا:
 * - يمرر تلقائياً batchType و pendingApproval و fromFarm و farmSyncedAt و initialEggs و hatchedChicks و hatchRate
 * - يحمي حجوزات العملاء (booked) والمخزون (stock) من المسح عند أي تحديث
 */
export async function syncBatchToCRM(batchId, data, isNew = false) {
    const batchDocRef = doc(crmDb, "inventory", "batches");

    let shouldInitializeNew = isNew;
    if (!shouldInitializeNew) {
        try {
            const snap = await getDoc(batchDocRef);
            if (!snap.exists() || !snap.data()?.[batchId]) {
                shouldInitializeNew = true;
            }
        } catch (err) {
            // نكمل بالدمج الآمن
        }
    }

    const intFields = new Set([
        'initialEggs', 'hatchedChicks', 'expectedChicks',
        'aliveBirds', 'unfertilized', 'deadInShell', 'expectedPairs'
    ]);
    const protectedFields = new Set(['stock', 'booked']);

    const payload = {};
    Object.entries(data || {}).forEach(([k, v]) => {
        if (v === undefined || protectedFields.has(k)) return;
        if (intFields.has(k)) {
            payload[k] = Math.max(0, Math.floor(Number(v) || 0));
        } else if (k === 'hatchRate') {
            payload[k] = Number(v) || 0;
        } else {
            payload[k] = v;
        }
    });
    payload.updatedAt = Date.now();

    if (shouldInitializeNew) {
        await setDoc(batchDocRef, {
            [batchId]: {
                isOpen: false,
                isVisible: false,
                pendingApproval: true,
                initialEggs: 0,
                hatchedChicks: 0,
                hatchRate: 0,
                expectedPairs: 0,
                stock: {},
                booked: {},
                ...payload
            }
        }, { merge: true });
    } else if (Object.keys(payload).length > 0) {
        await setDoc(batchDocRef, { [batchId]: payload }, { merge: true });
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
