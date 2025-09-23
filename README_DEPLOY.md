# Deploy: GitHub Pages (client) + Railway (signaling)

## 1) Prepare repo
- Create a new GitHub repo and push folder `webrtc-mvp` as root.
- Ensure files exist: `public/index.html`, `server.js`, `package.json`.

## 2) Deploy signaling to Railway
- Create new Railway project → Deploy from repo → Service type: Node.js
- Variables: none required (uses `PORT` provided by Railway)
- Start command: `node server.js`
- Enable WebSockets in service settings (default is enabled)
- After deploy, note the public URL like `https://your-app.up.railway.app`

## 3) Deploy client to GitHub Pages
- Settings → Pages → Build from branch → select branch (e.g., `main`), publish from `/docs`.
- Create a `docs/` folder and copy `public/*` into it on the `main` branch.
- Open the Pages URL, e.g., `https://<user>.github.io/<repo>/`

## 4) Configure client to point to Railway
On the GitHub Pages URL, add query param `?signal=YOUR_RAILWAY_URL`:

```
https://<user>.github.io/<repo>/?signal=https://your-app.up.railway.app
```

The page will connect its Socket.IO client to Railway for signaling. WebRTC media is P2P; TURN remains as in the file (replace with your own for production).

## 5) Test
- Open the Pages URL with `?signal=...` on two devices, same room id → Join → Call or wait for auto‑call.
- Make sure both are on HTTPS; camera prompts will appear.

## Notes
- For custom domain on Pages and Railway, set CNAME and ensure both are HTTPS.
- Replace the temporary TURN servers in `public/index.html` with your own `coturn` for reliability.
