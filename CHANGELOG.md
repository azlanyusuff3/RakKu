# RakKu Changelog

## v2.1.0 — PDF Book Import
- Tambah **Import PDF** dari Rak Buku dan Buku Baru.
- Setiap page PDF dirender menjadi page RakKu, page pertama jadi cover selepas save.
- Nama buku auto diambil daripada nama fail PDF dan masih boleh diedit.
- Import diproses satu page pada satu masa dengan progress untuk kurangkan penggunaan memory.
- PDF pages ikut setting Compact / HD / HD+.
- PDF.js 3.11.174 dipin dan PWA cuba cache engine untuk kegunaan offline selepas update dibuka online sekali.
- Tiada PDF atau page dihantar ke server oleh RakKu.

# Changelog

## v2.0.0 — Local Family Edition

- Added Parent PIN and Family Profiles.
- Added Kids Mode and per-profile reading progress/favourites.
- Added offline book scanner pipeline.
- Added auto crop/straighten heuristic.
- Added automatic and manual double-page split.
- Added HD scan modes and JPEG compression.
- Added `.rakku` portable binary book sharing.
- Added full-library backup/restore.
- Added two-page reading spread.
- Added device storage meter and persistent-storage request.
- Kept PDF export and offline PWA behavior.
- Migrates the same IndexedDB database from v1 without intentionally clearing existing books.
