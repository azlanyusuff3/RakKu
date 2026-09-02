# RakKu v2.1 — Local Family Edition

RakKu ialah PWA rak buku keluarga yang direka untuk menyimpan buku secara **local-first / offline**. Buku boleh discan menggunakan kamera atau Gallery, dibaca dengan swipe, diexport sebagai PDF, dan dipindahkan ke Android/iPhone/iPad lain menggunakan fail `.rakku` tanpa Supabase atau cloud database.

## Apa yang ada dalam v2

- Family Profiles: Parent + banyak profil anak
- Parent PIN untuk fungsi scan/edit/delete/backup
- Kids Mode: baca, favourite dan progress sendiri
- Camera scanner + multi-image Gallery import
- Auto crop + straighten/perspective-style correction (offline heuristic)
- Auto double-page split untuk gambar buku landscape
- Manual split jika auto split tidak trigger
- HD cleanup + resize/compression (Compact / HD / HD+)
- IndexedDB local storage
- Swipe reader + single page / two-page spread
- Reading progress & favourite ikut profil
- Export buku ke `.rakku`
- Import `.rakku` pada device lain (Android/iPhone/iPad)
- Full Library Backup / Restore `.rakku`
- Export PDF
- Offline PWA Service Worker
- Storage meter + persistent-storage request
- Tiada npm/build step dan tiada CDN dependency

## Penting tentang scanner

Auto crop/straighten RakKu v2.1 menggunakan image-processing heuristic yang berjalan terus dalam browser supaya kekal offline. Ia bukan OpenCV/cloud AI. Hasil terbaik apabila:

1. Background berbeza jelas daripada page.
2. Lighting sekata dan tidak terlalu banyak shadow.
3. Kamera berada hampir tegak di atas buku.
4. Untuk double-page, buku dibuka landscape dan gutter/garisan tengah jelas.

Jika auto split tidak tepat, matikan `Auto double-page split` atau gunakan butang `↔` pada thumbnail untuk split manual.

## Format `.rakku`

`.rakku` ialah portable binary container RakKu v2.1. Ia menyimpan metadata dan page JPEG tanpa base64 supaya lebih compact. Fail boleh dipindah melalui Files, Google Drive, OneDrive, WhatsApp sebagai Document, Telegram, AirDrop, Quick Share atau kaedah file-sharing lain. Pada device penerima buka RakKu → **Import** → pilih fail `.rakku`.

PDF kekal sebagai format export untuk dibaca di luar RakKu. `.rakku` ialah format terbaik untuk pindah/edit dalam RakKu.

## Privacy

RakKu v2.1 tidak upload gambar atau progress ke server. Semua data buku berada dalam browser storage pada device. Oleh itu:

- Jangan clear site/browser data tanpa membuat backup.
- Buat `Backup Library` secara berkala.
- Parent PIN ialah app-level lock, **bukan encryption keselamatan tinggi**.

## Deploy

Tiada build diperlukan. Upload semua fail/folder dalam repo ini ke root GitHub repository, kemudian aktifkan GitHub Pages. Lihat `DEPLOY_GITHUB.md`.


## Import PDF → Buku
Parent boleh tekan **📄 PDF** di Rak Buku atau **📄 Import PDF** dalam Buku Baru. RakKu render setiap page PDF menjadi page buku local, auto guna nama fail sebagai nama buku, kemudian page boleh disusun/dibuang sebelum **Simpan Buku**.

PDF processing berlaku dalam device. PDF.js 3.11.174 digunakan sebagai renderer dan service worker cuba cache engine itu. Selepas v2.1 berjaya dibuka online sekali, PDF import direka untuk terus tersedia offline pada browser/device yang mengekalkan cache PWA.

Untuk PDF yang sangat panjang, processing boleh mengambil masa dan menggunakan lebih banyak local browser storage kerana setiap page disimpan sebagai JPEG HD.
