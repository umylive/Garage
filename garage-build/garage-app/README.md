# 🔧 Garage — Self-Hosted Vehicle Maintenance Tracker

Mobile-friendly PWA for tracking car maintenance schedules. Built for Unraid.

## Features

- ✅ Multi-car support
- ✅ Pre-loaded Audi A6 C8 45 TFSI schedule (toggle on creation)
- ✅ Service logging with date, km, cost, workshop, notes
- ✅ Photo/receipt attachments
- ✅ Status indicators: OK / Due Soon / Overdue / Never / Condition-based
- ✅ Reminders tab — see what's due
- ✅ Excel + PDF export
- ✅ Bilingual (English / Arabic) item names
- ✅ Mobile PWA — install to home screen, works offline (read-only)
- ✅ All data stays on your server

## Quick Start on Unraid

### Option 1: Via docker-compose (recommended for first install)

1. SSH into Unraid or open the terminal
2. Create the project folder:
   ```bash
   mkdir -p /mnt/user/appdata/garage-build
   cd /mnt/user/appdata/garage-build
   ```
3. Copy all files from this project into that folder
4. Build and run:
   ```bash
   docker-compose up -d --build
   ```
5. Open `http://YOUR_UNRAID_IP:8765` in your browser

### Option 2: Via Unraid Docker tab using the included template

1. Build the image once:
   ```bash
   cd /path/to/garage-app
   docker build -t garage:latest .
   ```
2. Copy `garage.xml` to `/boot/config/plugins/dockerMan/templates-user/`
3. Go to Unraid Docker tab → "Add Container" → select "garage" from the dropdown
4. Adjust port/path if needed → Apply

The app will appear in your Docker tab like any Community Apps install.

### Option 3: Publish to Community Applications (later)

To get this listed in CA officially:
1. Push the Docker image to Docker Hub or GHCR (`docker push youruser/garage:latest`)
2. Update `garage.xml` `<Repository>` to point to your published image
3. Host the XML in a public GitHub repo
4. Submit a PR to https://github.com/Squidly271/AppFeed.applications.json (CA template repo)

## Mobile Access

### Local network
Just open `http://YOUR_UNRAID_IP:8765` on your phone's browser. To install as a PWA:
- **iPhone (Safari)**: Tap Share → "Add to Home Screen"
- **Android (Chrome)**: Tap menu → "Install app" or "Add to Home Screen"

### External access (from outside your network)
You'll need a reverse proxy. Pick one of:

#### A) Cloudflare Tunnel (recommended — no port forwarding, free)
1. Install the Cloudflare Tunnel app from Community Applications
2. Create a tunnel pointing to `http://localhost:8765`
3. Map a hostname like `garage.yourdomain.com`

#### B) SWAG / NPM (Nginx Proxy Manager)
If you already use one:
- Proxy: `http://YOUR_UNRAID_IP:8765`
- Add SSL via Let's Encrypt
- Optionally add basic auth or Authelia for security

## Data Location

Everything is stored at `/mnt/user/appdata/garage`:
- `garage.db` — SQLite database (cars, service items, logs)
- `uploads/` — photos and receipts

**Backup tip**: Add `/mnt/user/appdata/garage` to your CA Backup/Restore plugin schedule.

## Updating

```bash
cd /path/to/garage-app
docker-compose down
git pull   # or copy new files
docker-compose up -d --build
```

## File Structure

```
garage-app/
├── backend/
│   ├── server.js         # Express API
│   ├── database.js       # SQLite + seed data
│   └── package.json
├── frontend/
│   ├── index.html        # SPA — all UI lives here
│   ├── manifest.json     # PWA manifest
│   ├── sw.js             # Service worker (offline cache)
│   └── icon.svg
├── Dockerfile
├── docker-compose.yml
├── garage.xml            # Unraid Docker template
└── README.md
```

## Tech Stack

- **Backend**: Node.js 20 + Express + better-sqlite3
- **Frontend**: Vanilla JS PWA (no build step, no framework)
- **Database**: SQLite (single file, perfect for self-hosting)
- **Container**: Alpine Linux (~150MB image)

## Security Notes

The app has **no built-in authentication**. For external access, put it behind:
- Cloudflare Access (zero-trust, free for personal)
- Authelia / Authentik (self-hosted SSO)
- Basic HTTP auth via your reverse proxy

Don't expose port 8765 directly to the internet without a proxy.

## Troubleshooting

**Container won't start?**
```bash
docker logs garage
```

**Permission errors on /data?**
```bash
chown -R 1000:1000 /mnt/user/appdata/garage
```

**Database locked errors?**
SQLite uses WAL mode. If you see locks, restart the container:
```bash
docker restart garage
```
