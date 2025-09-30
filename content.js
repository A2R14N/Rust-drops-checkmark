const STORAGE_KEY = 'fp_drops_collected_v1';

async function loadCollected() {
    try {
        return await new Promise(res => {
            chrome.storage.sync.get([STORAGE_KEY], obj => res(obj?.[STORAGE_KEY] || {}));
        });
    } catch {
        return {};
    }
}

async function saveCollected(collected) {
    try {
        const o = {};
        o[STORAGE_KEY] = collected;
        await new Promise(res => chrome.storage.sync.set(o, res));
    } catch {}
}

// Inject FontAwesome if not present
(function injectFontAwesome() {
    if (!document.getElementById('fp-fa-css')) {
        const link = document.createElement('link');
        link.id = 'fp-fa-css';
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css';
        document.head.appendChild(link);
    }
})();

let attachScheduled = false;

async function attachButtons() {
    if (attachScheduled) return;
    attachScheduled = true;
    setTimeout(async () => {
        attachScheduled = false;
        const collected = await loadCollected();

        document.querySelectorAll('.drop-box-body').forEach(body => {
            if (body.querySelector('.fp-mark-btn')) return;
            body.style.position = 'relative';

            const dropBox = body.closest('.drop-box');
            let id = dropBox?.dataset.itemId 
                || dropBox?.querySelector('[data-itemid]')?.dataset.itemid
                || body.querySelector('img')?.src
                || body.querySelector('video source')?.src
                || body.innerText.trim();

            const btn = document.createElement('button');
            btn.className = 'fp-mark-btn';
            btn.title = collected[id] ? "Unmark as collected" : "Mark as collected";
            if (collected[id]) {
                btn.innerHTML = `<i class="fa-solid fa-check fp-check"></i>`;
                btn.classList.add("collected");
            } else {
                btn.innerHTML = `<i class="fa-solid fa-plus fp-plus"></i>`;
            }

            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                e.preventDefault();

                const current = await loadCollected();
                current[id] = !current[id];
                await saveCollected(current);

                if (current[id]) {
                    btn.innerHTML = `<i class="fa-solid fa-check fp-check"></i>`;
                    btn.classList.add("collected");
                    btn.title = "Unmark as collected";
                } else {
                    btn.innerHTML = `<i class="fa-solid fa-plus fp-plus"></i>`;
                    btn.classList.remove("collected");
                    btn.title = "Mark as collected";
                }
            });

            body.appendChild(btn);
        });
    }, 50);
}

(function injectButtonCSS() {
    if (document.getElementById('fp-drops-btn-css')) return;
    const style = document.createElement('style');
    style.id = 'fp-drops-btn-css';
    style.textContent = `
    .fp-mark-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 30;
        background: #181a20;
        color: inherit;
        border: 2px solid #ff7e2d;
        border-radius: 50%;
        width: 32px;
        height: 32px;
        font-size: 20px;
        font-family: 'Segoe UI', 'Arial', sans-serif;
        font-weight: 700;
        padding: 0;
        display: grid;
        place-items: center;
        box-shadow: 0 0 10px 2px #ff7e2d, 0 0 0 0 #ff7e2d;
        cursor: pointer;
        transition: background 0.18s, color 0.18s, border 0.18s, box-shadow 0.18s, transform 0.18s cubic-bezier(.4,2,.3,1);
        outline: none;
        user-select: none;
        opacity: 0.97;
        backdrop-filter: blur(2px);
    }
    .fp-mark-btn:hover {
        background: #23262f;
        color: #fff;
        border-color: #ff7e2d;
        box-shadow: 0 0 18px #ff7e2d, 0 2px 12px rgba(255,126,45,0.18);
        transform: scale(1.08);
    }
    .fp-plus {
        color: #ff7e2d !important;
        font-size: 24px;
        line-height: 1;
        display: block;
        text-align: center;
        margin-left: 4px;
        margin-right: 4px;
    }
    .fp-check {
        margin-top: 3px;
        font-size: 24px;
        display: block;
        text-align: center;
    }
    .fp-mark-btn:active {
        transform: scale(0.93);
        box-shadow: 0 0 8px #ff7e2d;
    }
    .fp-mark-btn.collected {
        background: rgba(34,197,94,0.18);
        color: #22c55e;
        border: 2px solid #22c55e;
        box-shadow: 0 0 24px #22c55e, 0 0 0 3px rgba(34,197,94,0.15);
        opacity: 1;
        animation: fp-btn-pulse-green 0.4s;
        font-family: 'Orbitron', 'Segoe UI', 'Arial', sans-serif;
    }
    @keyframes fp-btn-pulse-green {
        0% { box-shadow: 0 0 0 0 #22c55e; }
        50% { box-shadow: 0 0 0 12px #22c55e44; }
        100% { box-shadow: 0 0 24px #22c55e, 0 0 0 3px #22c55e44; }
    }
    .drop-box-body {
        position: relative !important;
    }
    `;
    document.head.appendChild(style);
})();

const observer = new MutationObserver(() => attachButtons());
observer.observe(document.body, { childList: true, subtree: true });

attachButtons();