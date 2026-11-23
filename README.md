# Pi Harness

A monochrome Windows desktop app for the free-pi coding agent.

## Run from source

```
npm install
npm start
```

## Build the single-file Windows app

```
npm run icons    # regenerate build/icon.png + build/icon.ico from build/logo.svg
npm run build    # writes dist/Pi-Harness-Setup.exe
```

## Landing page and installer

- `docs/index.html` — GitHub Pages landing page (served from `/docs` on `main`)
- `docs/install.ps1` — one-line PowerShell installer (`irm https://<owner>.github.io/<repo>/install.ps1 | iex`)

The app needs Node.js 22+ and the free-pi runtime (`free-pi-cli`); the welcome screen installs and signs in both.
