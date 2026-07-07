const pet = document.getElementById("pet-launcher");
const menu = document.getElementById("pet-menu");
const openButton = document.getElementById("pet-open");
const closeButton = document.getElementById("pet-close");
const MIN_OPACITY = 0.18;
let drag = null;

pet.addEventListener("pointerdown", async (event) => {
    if (!window.desktopWindow) return;
    event.preventDefault();
    if (event.button === 2) return;
    hideMenu();
    const state = await window.desktopWindow.getState();
    drag = {
        startX: event.screenX,
        startY: event.screenY,
        winX: state.bounds ? state.bounds.x : 0,
        winY: state.bounds ? state.bounds.y : 0,
        moved: false
    };
    pet.setPointerCapture(event.pointerId);
});

pet.addEventListener("pointermove", (event) => {
    if (!drag || !window.desktopWindow) return;
    event.preventDefault();
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
    }
    window.desktopWindow.setPosition(drag.winX + dx, drag.winY + dy);
});

pet.addEventListener("pointerup", (event) => {
    if (!drag) return;
    event.preventDefault();
    const shouldToggle = !drag.moved;
    drag = null;
    if (!shouldToggle) return;
    window.desktopWindow && window.desktopWindow.toggleStats();
});

window.addEventListener("wheel", async (event) => {
    if (!event.ctrlKey || !window.desktopWindow) return;
    event.preventDefault();
    const state = await window.desktopWindow.getState();
    const next = normalizeOpacity((state.opacity || 1) + (event.deltaY < 0 ? 0.05 : -0.05));
    await window.desktopWindow.setOpacity(next);
}, { passive: false });

pet.addEventListener("dragstart", (event) => event.preventDefault());
pet.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showMenu(event.clientX, event.clientY);
});

openButton.addEventListener("click", () => {
    hideMenu();
    window.desktopWindow && window.desktopWindow.toggleStats();
});

closeButton.addEventListener("click", () => {
    hideMenu();
    window.desktopWindow && window.desktopWindow.close();
});

window.addEventListener("pointerdown", (event) => {
    if (menu.hidden || menu.contains(event.target)) return;
    hideMenu();
});

function normalizeOpacity(value) {
    const next = Number(value) || 1;
    if (next >= 0.985) return 1;
    return Math.max(MIN_OPACITY, Math.min(1, next));
}

function showMenu(x, y) {
    const maxX = Math.max(4, window.innerWidth - 96);
    const maxY = Math.max(4, window.innerHeight - 66);
    menu.style.left = `${Math.min(Math.max(4, x), maxX)}px`;
    menu.style.top = `${Math.min(Math.max(4, y), maxY)}px`;
    menu.hidden = false;
}

function hideMenu() {
    menu.hidden = true;
}
