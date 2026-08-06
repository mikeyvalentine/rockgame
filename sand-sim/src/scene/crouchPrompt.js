/**
 * The one line shown when the player is standing on a pile.
 *
 * Deliberately one line and no explanation, per the barebones-UI rule: it names
 * the control and stops. What is under your feet says the rest.
 */
export function createCrouchPrompt() {
    const el = document.createElement("div");
    el.id = "crouch-prompt";
    el.style.cssText = [
        "position:fixed", "left:50%", "bottom:12%", "transform:translateX(-50%)",
        "padding:6px 14px", "border-radius:4px",
        "background:rgba(7,11,18,0.62)", "color:#dbe6f2",
        "font:500 13px/1.4 var(--stefan-tight, ui-sans-serif), ui-sans-serif",
        "letter-spacing:0.06em", "text-transform:lowercase",
        "pointer-events:none", "opacity:0", "transition:opacity 160ms ease",
        "z-index:60",
    ].join(";");
    el.textContent = "press e to sift";
    document.body.appendChild(el);
    return {
        show: (on) => { el.style.opacity = on ? "1" : "0"; },
        dispose: () => el.remove(),
    };
}
