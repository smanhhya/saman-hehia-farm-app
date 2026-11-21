# هيكل مشروع نظام إدارة مزرعة سمان ههيا (ERP)

```text
saman-hehia-farm-app/
├── .github/
│   └── workflows/
│       └── build-apk.yml          ← نشر GitHub Pages + بناء APK بتوقيع ثابت وتحديث تلقائي
├── PROJECT_STRUCTURE.md           ← خريطة وهيكلة ملفات المشروع وقواعد البيانات
├── package.json                   ← إعدادات Capacitor 6 والإضافات الأصلية
├── capacitor.config.json          ← هوية التطبيق وربطه بمجلد www
└── www/
    ├── index.html                 ← الواجهة الرئيسية الموحدة (متوافقة مع الموبايل والأندرويد)
    ├── manifest.json              ← بيانات تطبيق الويب التقدمي PWA
    ├── sw.js                      ← Service Worker بنمط Network-First للتحديث السريع
    ├── version.json               ← رقم الإصدار ورابط التحديث (يتولّد تلقائياً عند البناء)
    ├── css/
    │   └── style.css              ← نظام التصميم + الوضع الليلي + Safe Area
    └── js/
        ├── config/
        │   └── firebase.js        ← الربط المزدوج (Farm RTDB sman-6512c + CRM Firestore sman-ca8f8)
        ├── core/
        │   ├── state.js           ← المخزن المركزي الموحد والمعايير البيولوجية للطيور
        │   ├── ui.js              ← التنقل + زر الرجوع للأندرويد + Loader + Toast + قفل الأزرار
        │   ├── validators.js      ← فحص صارم للمدخلات ومنع السالب والـ NaN وحماية XSS
        │   └── accounting.js      ← المحرك المحاسبي (متوسط العلف WAC + التقفيل + عكس الحذف)
        ├── modules/
        │   ├── breeders.js        ← نظام الأمهات Pro (تعدد القطعان/الإحلال + تحكم البيض + التحليلات)
        │   ├── incubator.js       ← خريطة الأرفف + الدمج الذكي + الترحيل الفوري للـ CRM (عمر يوم)
        │   ├── rearing.js         ← عنابر التربية + اليوميات + دليل العامل + تحديث CRM لحظياً
        │   ├── freezer.js         ← الفريزر الديناميكي + تصنيف وهالك الذبح + FIFO حقيقي
        │   ├── finance.js         ← المركز المالي الموحد + الأرشيف + التقفيل الشهري
        │   ├── reports.js         ← تقارير ربحية الدفعة (Batch P&L + FCR + تكلفة الجوز)
        │   ├── inventory.js       ← جرد المعدات والأصول الثابتة
        │   └── settings.js        ← الإعدادات الكاملة + نسخ احتياطي واستعادة JSON
        └── app.js                 ← نقطة التشغيل + محرك التحديث التلقائي + مستمعات Firebase
