# Deploy RakKu ke GitHub Pages

## 1. Create repository

Di GitHub, create repository bernama contoh `rakku`.

## 2. Upload SEMUA isi folder ini

Struktur di root repository mesti seperti:

```text
rakku/
├── index.html
├── manifest.webmanifest
├── sw.js
├── README.md
├── DEPLOY_GITHUB.md
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── icon-maskable-512.png
└── src/
    ├── main.js
    └── style.css
```

Jangan upload ZIP sahaja. Extract ZIP dan upload isi folder.

## 3. GitHub Pages

Repository → Settings → Pages → Build and deployment:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/ (root)`
- Save

GitHub akan memberi URL seperti:

```text
https://USERNAME.github.io/rakku/
```

RakKu memerlukan HTTPS untuk pengalaman PWA/camera yang betul. GitHub Pages menyediakan HTTPS.

## 4. Android

1. Buka URL RakKu dengan Chrome.
2. Menu `⋮` → `Install app` / `Add to Home screen`.
3. Buka RakKu dari icon Home Screen.

## 5. iPhone / iPad

1. Buka URL RakKu menggunakan Safari.
2. Tekan Share.
3. `Add to Home Screen` → Add.
4. Buka RakKu dari Home Screen.

## 6. Cara pindah buku Android ↔ iPhone/iPad

Pada Parent Mode device asal:

1. Tekan `📤` pada buku.
2. RakKu menghasilkan `Nama_Buku.rakku`.
3. Share/save fail menggunakan Files/Drive/WhatsApp Document/AirDrop/Quick Share dan sebagainya.

Pada device penerima:

1. Buka RakKu.
2. Masuk Parent Mode.
3. Tekan `📥 Import`.
4. Pilih fail `.rakku`.
5. Buku masuk ke bookshelf local device tersebut.

Untuk pindah semua sekali, gunakan `Settings → Backup Library`, kemudian `Restore` pada device baru.

## Update version kemudian

Upload fail version baru ke repository yang sama dan commit. Service Worker RakKu menggunakan cache versioned; bila app dibuka online selepas deployment baru, static app shell akan dikemas kini. Data IndexedDB/books local tidak dipadam oleh update code biasa.
