# Third-party notices

RakKu v2.1 uses **Mozilla PDF.js 3.11.174** for client-side PDF page rendering.

- Project: https://github.com/mozilla/pdf.js
- Distribution: https://cdnjs.com/libraries/pdf.js/3.11.174
- License: Apache License 2.0

RakKu references pinned PDF.js files and the PWA service worker attempts to cache them for offline use. PDF contents selected by the user are processed on-device and are not uploaded by RakKu.
