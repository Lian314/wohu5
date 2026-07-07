# Desktop build

The app is an Electron desktop floating-window app. Windows uses the notification tray, while macOS uses the menu bar tray through the same Electron `Tray` API.

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
