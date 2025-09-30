// Only keep storage logic for use in content.js

const STORAGE_KEY = 'fp_drops_collected_v1';

function readStorage() {
    return new Promise((res) => chrome.storage.sync.get([STORAGE_KEY], (obj) => res(obj[STORAGE_KEY] || {})));
}
function writeStorage(data) {
    return new Promise((res) => {
        const o = {};
        o[STORAGE_KEY] = data;
        chrome.storage.sync.set(o, () => res());
    });
}

function render(list) {
    const container = document.getElementById('list');
    container.innerHTML = '';
    const keys = Object.keys(list);
    if (keys.length === 0) { container.innerHTML = '<div style="padding:8px">No items saved yet. Open the drops page and click the + buttons.</div>'; return; }
    keys.forEach(k => {
        const row = document.createElement('div');
        row.className = 'item';
        const name = document.createElement('div');
        name.className = 'name';
        const meta = list[k] && list[k] !== false ? (list[k]===true? 'Collected' : JSON.stringify(list[k])) : 'Missing';
        name.textContent = `${k} — ${meta}`;
        const toggle = document.createElement('button');
        toggle.className = 'btn';
        toggle.textContent = (list[k] ? 'Unmark' : 'Mark');
        toggle.addEventListener('click', async () => {
            const stored = await readStorage();
            stored[k] = !stored[k];
            await writeStorage(stored);
            render(stored);
        });
        const remove = document.createElement('button');
        remove.className = 'btn';
        remove.textContent = 'Delete';
        remove.addEventListener('click', async () => {
            const s = await readStorage();
            delete s[k];
            await writeStorage(s);
            render(s);
        });
        row.appendChild(name);
        row.appendChild(toggle);
        row.appendChild(remove);
        container.appendChild(row);
    });
}

(async function() {
    const stored = await readStorage();
    render(stored);
    document.getElementById('exportBtn').addEventListener('click', async () => {
        const s = await readStorage();
        document.getElementById('io').value = JSON.stringify(s, null, 2);
    });
    document.getElementById('importBtn').addEventListener('click', async () => {
        try {
            const text = document.getElementById('io').value.trim();
            if (!text) return alert('Paste JSON into the textarea');
            const parsed = JSON.parse(text);
            await writeStorage(parsed);
            render(parsed);
            alert('Imported');
        } catch (e) {
            alert('Invalid JSON');
        }
    });
    document.getElementById('clearBtn').addEventListener('click', async () => {
        if (!confirm('Clear all saved marks?')) return;
        await writeStorage({});
        render({});
    });
})();