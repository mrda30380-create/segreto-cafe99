# SEGRETO CAFE - Online version

المشروع محافظ على ملفات الموقع والصور ولوحة الإدارة والحماية، وتم استبدال SQLite بـ PostgreSQL ليعمل كخدمة ويب أونلاين.

## التشغيل محليًا
1. Node.js 18+.
2. أنشئ PostgreSQL وضع `DATABASE_URL` في `.env`.
3. ضع **نفس** قيمة `ADMIN_PASSWORD` التي تستخدمها حاليًا في `.env`.
4. `npm install`
5. `npm start`
6. الموقع: `http://localhost:3000/`
7. لوحة الإدارة: `http://localhost:3000/admin.html`

## Render
يوجد `render.yaml` لإنشاء Web Service + PostgreSQL.
بعد إنشاء الخدمة، تأكد أن `ADMIN_PASSWORD` مضبوط على **نفس كلمة المرور الحالية** في Environment Variables.
لا تضع كلمة المرور داخل أي ملف Frontend.

## الحماية
- Helmet.
- Rate limiting على `/api/`.
- كلمة مرور الإدارة من Environment Variables فقط.
- جلسة الإدارة في Cookie من نوع HttpOnly + SameSite=Strict، وSecure في الإنتاج.
- لا يتم قبول الحجز المؤكد `paid` من المتصفح.
- فحص التعارض على السيرفر داخل PostgreSQL transaction مع advisory lock لمنع الحجز المزدوج عند الطلبات المتزامنة.
- الدفع متروك بدون تفعيل حتى إضافة بوابة دفع حقيقية وWebhook.

## ملاحظة مهمة
الـZIP الأصلي لا يحتوي ملف `.env` ولا يحتوي كلمة مرور الإدارة نفسها، لذلك لا يمكن تضمين كلمة المرور السرية داخل الـZIP. احتفظ بنفس قيمتها في Environment Variables عند تشغيل Render.
