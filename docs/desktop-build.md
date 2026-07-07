# Desktop build

The app is an Electron desktop floating-window app. Windows uses the notification tray, while macOS uses the menu bar tray through the same Electron `Tray` API.

Use Node.js 22.12.0 or newer. Electron Builder 26 pulls packages that warn or fail on older Node versions.

## Windows

```powershell
npm ci
npm run dist:win
```

Output:

```text
release/Huya-Danmaku-Copilot-1.0.0.exe
```

## macOS

macOS packages must be built on macOS. Electron Builder rejects macOS packaging on Windows, so use a Mac machine or the GitHub Actions workflow in `.github/workflows/build-desktop.yml`.

If `npm ci` fails with `EACCES` under `~/.npm/_cacache`, fix the local npm cache ownership first:

```bash
sudo chown -R "$(id -u):$(id -g)" ~/.npm
npm cache verify
```

If the same path still fails because a cache entry is a bad file/directory, remove only the local npm cache and reinstall:

```bash
rm -rf ~/.npm/_cacache
npm ci
```

```bash
npm ci
npm run dist:mac
```

Outputs:

```text
release/Danmaku-Meme-Catcher-1.0.0-x64.dmg
release/Danmaku-Meme-Catcher-1.0.0-arm64.dmg
release/Danmaku-Meme-Catcher-1.0.0-x64.zip
release/Danmaku-Meme-Catcher-1.0.0-arm64.zip
```

The current macOS build is unsigned for internal testing. For public distribution, add Apple Developer signing and notarization secrets to the CI workflow before release.
