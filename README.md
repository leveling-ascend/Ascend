# ASCEND: The Takeover

33-week gamified NEET prep, fitness, and discipline campaign tracker.
React + Vite PWA, synced live via Firestore.

## Setup

```bash
npm install
```

Fill in `src/firebase.js` with ASCEND's own Firebase project config
(Firebase console → Project settings → General → Your apps → SDK setup
and configuration). This is a separate Firebase project from any other
app — data lives in its own `ascend_quest` collection.

## Develop

```bash
npm run dev
```

## Build & deploy

```bash
npm run build
```

Outputs to `dist/`. Deploy that folder to any static host (Firebase
Hosting, Vercel, Netlify, etc.). The service worker only registers on
`https://` or `localhost`, so installability/offline support won't
show up on a plain `http://` deployment.

## Notes

- `public/icon-192.png` and `public/icon-512.png` are placeholder
  icons — swap them for real artwork before shipping.
- Editing is gated by a simple PIN (Settings → Access), not Firebase
  auth — anyone with write access to the Firestore doc can bypass it,
  so lock down Firestore security rules on the `ascend_quest`
  collection before sharing the link widely.
- Local device state also caches to `localStorage` so the app keeps
  working offline; it re-syncs once the connection returns.
