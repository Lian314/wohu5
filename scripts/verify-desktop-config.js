const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertFile(relativePath, minBytes) {
    const fullPath = path.join(root, relativePath);
    assert(fs.existsSync(fullPath), `Missing required file: ${relativePath}`);
    const stat = fs.statSync(fullPath);
    assert(stat.size >= minBytes, `File is unexpectedly small: ${relativePath}`);
}

function targetsFor(platformConfig) {
    return (platformConfig.target || []).map((target) => target.target || target);
}

function archesFor(platformConfig) {
    return [...new Set((platformConfig.target || []).flatMap((target) => target.arch || []))].sort();
}

const pkg = JSON.parse(read('package.json'));
const main = read('app/main.js');
const styles = read('app/renderer/styles.css');
const workflow = read('.github/workflows/build-desktop.yml');
const docs = read('docs/desktop-build.md');

[
    ['app/renderer/assets/product-logo-ai-source.png', 100000],
    ['app/renderer/assets/product-logo.svg', 100],
    ['app/renderer/assets/icon.png', 100000],
    ['app/renderer/assets/icon.ico', 50000],
    ['app/renderer/assets/icon.icns', 100000],
    ['app/renderer/assets/tray.png', 200],
    ['app/renderer/assets/trayTemplate.png', 200]
].forEach(([relativePath, minBytes]) => assertFile(relativePath, minBytes));

assert(pkg.build.productName === '弹幕梗捕手', 'Product name should match the app brand.');
assert(pkg.build.win.icon === 'app/renderer/assets/icon.ico', 'Windows build must use the generated .ico.');
assert(pkg.build.win.signExecutable === false, 'Windows internal build should skip signing only, not resource editing.');
assert(targetsFor(pkg.build.win).includes('portable'), 'Windows build must produce a portable exe.');

assert(pkg.build.mac.icon === 'app/renderer/assets/icon.icns', 'macOS build must use the generated .icns.');
assert(pkg.build.mac.identity === null, 'macOS internal build should be unsigned unless release signing is configured.');
assert(pkg.build.mac.artifactName === 'Danmaku-Meme-Catcher-${version}-${arch}.${ext}', 'macOS artifact name should include arch and extension.');
assert(targetsFor(pkg.build.mac).includes('dmg'), 'macOS build must produce dmg.');
assert(targetsFor(pkg.build.mac).includes('zip'), 'macOS build must produce zip.');
assert(archesFor(pkg.build.mac).join(',') === 'arm64,x64', 'macOS build must target x64 and arm64.');

assert(main.includes('new Tray(getTrayIcon())'), 'Main process must create a system tray/menu bar item.');
assert(main.includes("process.platform === 'darwin'"), 'Main process must branch for macOS behavior.');
assert(main.includes("const APP_NAME = '弹幕梗捕手'"), 'Main process should define a shared app name.');
assert(main.includes('app.setName(APP_NAME)'), 'Main process should set the platform-visible app name.');
assert(main.includes("trayTemplate.png"), 'macOS tray should use a template icon.');
assert(main.includes('image.setTemplateImage(true)'), 'macOS tray icon should be marked as a template image.');
assert(main.includes('tray.popUpContextMenu()'), 'macOS menu bar click should open the tray menu.');
assert(main.includes('toggleStatsWindow()'), 'Windows tray click should toggle the stats window.');
assert(main.includes("tray.on('double-click', showStatsWindow)"), 'Tray double-click should open the stats window.');
assert(main.includes('app.dock.hide()'), 'macOS menu bar mode should hide the dock icon.');
assert(main.includes('app.setAppUserModelId'), 'Windows app user model id should be set for shell integration.');
assert(main.includes('tray.setContextMenu(menu)'), 'Tray must expose a context menu.');

assert(styles.includes('icon.png'), 'Renderer should use the generated AI product logo asset.');

assert(workflow.includes('runs-on: windows-latest'), 'CI must include Windows packaging.');
assert(workflow.includes('runs-on: macos-latest'), 'CI must include macOS packaging.');
assert(workflow.includes('npm run dist:win'), 'CI must run the Windows packaging script.');
assert(workflow.includes('npm run dist:mac'), 'CI must run the macOS packaging script.');
assert(workflow.includes('release/*.dmg') && workflow.includes('release/*.zip'), 'CI must upload macOS artifacts.');

assert(docs.includes('macOS packages must be built on macOS'), 'Build docs must explain the macOS build platform requirement.');
assert(docs.includes('npm run dist:mac'), 'Build docs must include the macOS packaging command.');

console.log('desktop config ok');
