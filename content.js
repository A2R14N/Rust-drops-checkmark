/**
 * Facepunch Drops — Manual Marker (v2.0)
 *
 * Chrome MV3 content script for twitch.facepunch.com and kick.facepunch.com.
 * Injects toggle buttons onto drop-box items so users can manually mark
 * items as collected. State is persisted via chrome.storage.sync with a
 * localStorage fallback, and synced across tabs in real time.
 *
 * Architecture:
 *   Single IIFE — no global leaks.
 *   Internally split into focused modules:
 *     CONFIG / Logger / Hash / StorageController / ItemIdentifier /
 *     ButtonFactory / DropScanner / StyleInjector / Bootstrap
 */
(() => {
  'use strict';

  /* ================================================================
   * 1. CONSTANTS & CONFIGURATION
   * ================================================================ */

  /**
   * @typedef {Object} SiteTheme
   * @property {string} prefix    - Storage key prefix ('kick_' | 'twitch_').
   * @property {string} color     - Primary accent hex colour.
   * @property {string} colorRgb  - Primary accent as comma-separated RGB.
   */

  /** @type {boolean} */
  const IS_KICK = window.location.hostname.includes('kick');

  /** Immutable runtime configuration. */
  const CONFIG = Object.freeze({
    /** chrome.storage.sync key. */
    STORAGE_KEY: 'fp_drops_collected_v1',

    /** Hard ceiling for stored entries before LRU eviction kicks in. */
    MAX_ITEMS: 2000,

    /**
     * chrome.storage.sync has a per-key quota of ~8 KB.
     * We target a conservative ceiling to avoid QUOTA_BYTES_PER_ITEM errors.
     */
    SYNC_BYTE_LIMIT: 8000,

    /** Debounce interval (ms) for MutationObserver-triggered scans. */
    DEBOUNCE_MS: 150,

    /** CSS id for the injected <style> element. */
    STYLE_ID: 'fp-drops-btn-css',

    /** Selector for the container we attach buttons to. */
    BODY_SELECTOR: '.drop-box-body',

    /** Selector for the parent drop box. */
    BOX_SELECTOR: '.drop-box',

    /** Log prefix shown in the console. */
    LOG_PREFIX: '[FP Drops]',
  });

  /** Per-site theming. */
  const SITE = Object.freeze(
    IS_KICK
      ? { prefix: 'kick_', color: '#53fc18', colorRgb: '83, 252, 24' }
      : { prefix: 'twitch_', color: '#ff7e2d', colorRgb: '255, 126, 45' },
  );

  /* ================================================================
   * 2. LOGGER
   * ================================================================ */

  /**
   * Structured logger with level gating.
   * In production `debug` is a no-op; bump `Logger.level` to 0 to enable.
   */
  const Logger = Object.freeze({
    /** @type {number} 0 = debug, 1 = info, 2 = warn, 3 = error */
    level: 1,

    /** @param {...unknown} args */
    debug(...args) {
      if (this.level <= 0) console.debug(CONFIG.LOG_PREFIX, ...args);
    },

    /** @param {...unknown} args */
    info(...args) {
      if (this.level <= 1) console.info(CONFIG.LOG_PREFIX, ...args);
    },

    /** @param {...unknown} args */
    warn(...args) {
      if (this.level <= 2) console.warn(CONFIG.LOG_PREFIX, ...args);
    },

    /** @param {...unknown} args */
    error(...args) {
      if (this.level <= 3) console.error(CONFIG.LOG_PREFIX, ...args);
    },
  });

  /* ================================================================
   * 3. HASHING (FNV-1a dual 32-bit)
   * ================================================================ */

  /**
   * Produces a short, deterministic hash from an arbitrary string.
   *
   * Uses two independent FNV-1a 32-bit passes with swapped seed/prime
   * to approximate 64-bit collision resistance while keeping output
   * compact (≤ 15 chars in base-36).
   *
   * @param {string} str - Input to hash.
   * @returns {string} Base-36 encoded hash in the form "h1_h2".
   */
  function hashString(str) {
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0x01000193 >>> 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
    }
    return (h1 >>> 0).toString(36) + '_' + (h2 >>> 0).toString(36);
  }

  /**
   * Serialises an object with keys sorted alphabetically to guarantee
   * identical string output for identical key-value structures.
   *
   * @param {any} obj - Object to serialise.
   * @returns {string}
   */
  function canonicalStringify(obj) {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    const keys = Object.keys(obj).sort();
    const sortedObj = {};
    for (const key of keys) {
      sortedObj[key] = obj[key];
    }
    return JSON.stringify(sortedObj);
  }

  /* ================================================================
   * 4. EXTENSION CONTEXT GUARD
   * ================================================================ */

  /**
   * Returns `true` when the extension service worker is still alive.
   * After an update or uninstall `chrome.runtime.id` becomes undefined.
   *
   * @returns {boolean}
   */
  function isExtensionValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  /* ================================================================
   * 5. STORAGE CONTROLLER
   * ================================================================ */

  /**
   * Manages persistence of collected-item state.
   *
   * Read path:  chrome.storage.sync → localStorage fallback.
   * Write path: localStorage (instant) → chrome.storage.sync (async).
   *
   * Exposes a simple get/toggle/onChange API.  All mutations are serialised
   * through an async mutex so concurrent clicks never corrupt state.
   */
  class StorageController {
    /** @param {function(): void} onExternalChange - Called when another tab writes. */
    constructor(onExternalChange) {
      /** @private @type {Object<string, number>|null} */
      this._cache = null;

      /** @private */
      this._onExternalChange = onExternalChange;

      /** @private @type {Promise<void>} */
      this._mutex = Promise.resolve();

      /** @private @type {number} */
      this._writeCount = 0;

      /** @private @type {Array<{str: string, timestamp: number}>} */
      this._writtenRepresentations = [];

      /** @private @type {boolean} */
      this._isListening = false;
    }

    /* ── Public API ─────────────────────────────────────────────── */

    /**
     * Initialise the cache from storage (idempotent).
     * Must be awaited before any reads.
     *
     * @returns {Promise<Object<string, number>>}
     */
    async init() {
      if (this._cache !== null) return this._cache;

      const localData = this._localGet();

      if (isExtensionValid()) {
        const data = await this._syncGet();
        if (data !== null) {
          // Merge sync and local data by keeping the latest timestamp for each key
          const merged = { ...data };
          let changed = false;

          for (const [key, localTs] of Object.entries(localData)) {
            const syncTs = data[key];
            if (syncTs === undefined) {
              merged[key] = localTs;
              changed = true;
            } else if (localTs > syncTs) {
              merged[key] = localTs;
              changed = true;
            }
          }

          this._cache = merged;
          if (changed) {
            // Write merged data back to sync/local
            await this._persist();
          } else {
            this._localSet(merged);
          }
        } else {
          this._cache = localData;
        }
      } else {
        this._cache = localData;
      }

      return this._cache;
    }

    /**
     * Whether an item is currently marked as collected.
     *
     * @param {string} id
     * @returns {boolean}
     */
    isCollected(id) {
      return this._cache !== null && !!this._cache[id];
    }

    /**
     * Toggle the collected state for `id`.
     * Returns the new state after toggling.
     * Mutations are serialised — safe to call from rapid clicks.
     *
     * @param {string} id
     * @returns {Promise<boolean>} `true` if the item is now collected.
     */
    toggle(id) {
      return this._withMutex(async () => {
        await this.init();

        if (this._cache[id]) {
          delete this._cache[id];
        } else {
          this._cache[id] = Date.now();
        }

        await this._persist();
        return !!this._cache[id];
      });
    }

    /* ── Private: mutex ─────────────────────────────────────────── */

    /**
     * Serialise async work so that concurrent callers execute sequentially.
     *
     * @private
     * @template T
     * @param {function(): Promise<T>} fn
     * @returns {Promise<T>}
     */
    _withMutex(fn) {
      const next = this._mutex
        .catch(() => {})
        .then(() => fn());
      this._mutex = next.catch(() => {});
      return next;
    }

    /* ── Private: chrome.storage.sync ───────────────────────────── */

    /**
     * @private
     * @returns {Promise<Object<string, number>|null>}
     */
    _syncGet() {
      return new Promise((resolve) => {
        try {
          chrome.storage.sync.get([CONFIG.STORAGE_KEY], (result) => {
            if (chrome.runtime.lastError) {
              Logger.warn('storage.sync.get error:', chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            resolve(result?.[CONFIG.STORAGE_KEY] ?? null);
          });
        } catch (err) {
          Logger.warn('storage.sync.get exception:', err);
          resolve(null);
        }
      });
    }

    /**
     * @private
     * @param {Object<string, number>} data
     * @returns {Promise<void>}
     */
    _syncSet(data) {
      return new Promise((resolve) => {
        try {
          chrome.storage.sync.set({ [CONFIG.STORAGE_KEY]: data }, () => {
            if (chrome.runtime.lastError) {
              Logger.warn('storage.sync.set error:', chrome.runtime.lastError.message);
            }
            resolve();
          });
        } catch (err) {
          Logger.warn('storage.sync.set exception:', err);
          resolve();
        }
      });
    }

    /**
     * Starts listening for sync changes from other tabs.
     * Called after initialisation to avoid race conditions.
     */
    startListening() {
      if (this._isListening || !isExtensionValid()) return;

      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'sync' || !changes[CONFIG.STORAGE_KEY]) return;

          const incoming = changes[CONFIG.STORAGE_KEY].newValue || {};
          const now = Date.now();
          const incomingStr = canonicalStringify(incoming);

          // Prune representations older than 30 seconds to prevent leaks
          this._writtenRepresentations = this._writtenRepresentations.filter(
            (r) => now - r.timestamp < 30000,
          );

          // Check if this was a self-write
          const idx = this._writtenRepresentations.findIndex((r) => r.str === incomingStr);
          if (idx !== -1) {
            // Remove this write and any older pending ones that are now superseded
            this._writtenRepresentations.splice(0, idx + 1);
            return;
          }

          this._withMutex(async () => {
            this._cache = incoming;
            this._localSet(incoming);
            this._onExternalChange();
          });
        });
        this._isListening = true;
      } catch {
        /* Extension context already invalidated — nothing to do. */
      }
    }

    /* ── Private: localStorage fallback ─────────────────────────── */

    /**
     * @private
     * @returns {Object<string, number>}
     */
    _localGet() {
      try {
        const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }

    /**
     * @private
     * @param {Object<string, number>} data
     */
    _localSet(data) {
      try {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
      } catch {
        /* localStorage full or unavailable — non-fatal. */
      }
    }

    /* ── Private: eviction & persist ────────────────────────────── */

    /**
     * LRU eviction: drops the oldest entries until both the item count
     * and serialised byte size are within quota.
     *
     * @private
     * @param {Object<string, number>} data - Mutated in place.
     * @returns {Object<string, number>}
     */
    _evict(data) {
      const keys = Object.keys(data);
      if (keys.length <= CONFIG.MAX_ITEMS && JSON.stringify(data).length <= CONFIG.SYNC_BYTE_LIMIT) {
        return data;
      }

      const sorted = keys
        .map((k) => ({ key: k, ts: data[k] }))
        .sort((a, b) => a.ts - b.ts);

      for (const entry of sorted) {
        delete data[entry.key];
        if (
          Object.keys(data).length <= CONFIG.MAX_ITEMS &&
          JSON.stringify(data).length <= CONFIG.SYNC_BYTE_LIMIT
        ) {
          break;
        }
      }

      return data;
    }

    /**
     * Write the cache to both localStorage and chrome.storage.sync.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _persist() {
      if (this._cache === null) return;

      this._cache = this._evict(this._cache);
      this._localSet(this._cache);

      if (!isExtensionValid()) return;

      this._writeCount++;
      if (this._writeCount === 100) {
        Logger.info('100+ storage writes this session.');
      }

      // Record this write's canonical form to recognize its onChanged event later
      this._writtenRepresentations.push({
        str: canonicalStringify(this._cache),
        timestamp: Date.now(),
      });

      await this._syncSet(this._cache);
    }
  }

  /* ================================================================
   * 6. ITEM IDENTIFIER
   * ================================================================ */

  /**
   * Extracts a stable, unique ID for a drop-box element.
   *
   * Priority order (most stable → least stable):
   *   1. `data-itemid` from a `.drop-counter` inside the box (persistent database ID)
   *   2. `data-streamer-hash` attribute on the parent `.drop-box`
   *   3. `id` attribute on the parent `.drop-box`
   *   4. Composite hash of the item name (`.drop-type`) + media source
   *   5. Hash of the element's static text content (last resort)
   */
  class ItemIdentifier {
    /**
     * @param {Element} bodyEl - A `.drop-box-body` element.
     * @returns {string|null} Prefixed unique ID, or null if undetermined.
     */
    static extract(bodyEl) {
      const dropBox = bodyEl.closest(CONFIG.BOX_SELECTOR);

      // 1. data-itemid on the claim counter
      const counterEl = dropBox?.querySelector('.drop-counter[data-itemid]');
      if (counterEl?.dataset?.itemid) {
        return SITE.prefix + 'item_' + counterEl.dataset.itemid;
      }

      // 2. data-streamer-hash (Facepunch-generated)
      if (dropBox?.dataset?.streamerHash) {
        return SITE.prefix + dropBox.dataset.streamerHash;
      }

      // 3. Element id (also Facepunch-generated on streamer tiles)
      if (dropBox?.id) {
        return SITE.prefix + dropBox.id;
      }

      // 4. Composite: item name + media source
      const nameEl = dropBox?.querySelector('.drop-type')
        || bodyEl.querySelector('[data-item-name], .drop-name, .item-name, h3, h4');
      const itemName = nameEl ? nameEl.textContent.trim() : '';

      const mediaEl = bodyEl.querySelector('video source[src], img[src]');
      const mediaSrc = mediaEl ? mediaEl.getAttribute('src') : '';

      if (itemName || mediaSrc) {
        return SITE.prefix + 'composite_' + hashString(mediaSrc + '|' + itemName);
      }

      // 5. Static text content (strip dynamic numbers)
      const staticText = bodyEl.innerText
        .trim()
        .replace(/\d+:\d+/g, '')
        .replace(/\d[\d,.]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (staticText.length > 0) {
        return SITE.prefix + 'text_' + hashString(staticText);
      }

      return null;
    }
  }

  /* ================================================================
   * 7. SVG ICONS
   * ================================================================ */

  /** SVG path data for the two button states. ViewBox: 0 0 448 512 (FA). */
  const SVG_PATHS = Object.freeze({
    check:
      '<path d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5' +
      ' 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8' +
      '-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"/>',
    plus:
      '<path d="M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32V224H48c-17.7' +
      ' 0-32 14.3-32 32s14.3 32 32 32H192V432c0 17.7 14.3 32 32 32s32-14.3' +
      ' 32-32V288H400c17.7 0 32-14.3 32-32s-14.3-32-32-32H256V80z"/>',
  });

  /**
   * Pre-built `<template>` elements for each icon so we can clone instead
   * of parsing HTML on every button render.
   *
   * @type {Object<string, HTMLTemplateElement>}
   */
  const SVG_TEMPLATES = (() => {
    const templates = {};
    for (const [name, pathData] of Object.entries(SVG_PATHS)) {
      const tpl = document.createElement('template');
      tpl.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"` +
        ` class="fp-icon fp-${name}" aria-hidden="true">${pathData}</svg>`;
      templates[name] = tpl;
    }
    return Object.freeze(templates);
  })();

  /**
   * Clone an SVG icon from a pre-parsed template.
   *
   * @param {'check'|'plus'} name
   * @returns {SVGSVGElement}
   */
  function cloneIcon(name) {
    return /** @type {SVGSVGElement} */ (
      SVG_TEMPLATES[name].content.firstElementChild.cloneNode(true)
    );
  }

  /* ================================================================
   * 8. BUTTON FACTORY
   * ================================================================ */

  /**
   * Creates and manages the toggle buttons injected into each drop box.
   */
  class ButtonFactory {
    /**
     * @param {StorageController} storage
     */
    constructor(storage) {
      /** @private */
      this._storage = storage;

      /**
       * Maps item-ID → { ref: WeakRef<HTMLButtonElement>, bodyRef: WeakRef<Element> }.
       * Using WeakRef ensures we don't prevent GC of detached DOM nodes.
       *
       * @private
       * @type {Map<string, {ref: WeakRef<HTMLButtonElement>, bodyRef: WeakRef<Element>}>}
       */
      this._registry = new Map();
    }

    /**
     * Create a button, wire its click handler, and append it to `bodyEl`.
     *
     * @param {Element} bodyEl - The `.drop-box-body` element.
     * @param {string}  id     - Unique item identifier.
     */
    create(bodyEl, id) {
      const btn = document.createElement('button');
      btn.className = 'fp-mark-btn';
      btn.type = 'button';
      btn.setAttribute('role', 'switch');

      this._render(btn, this._storage.isCollected(id));

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const nowCollected = await this._storage.toggle(id);
        this._render(btn, nowCollected);
      });

      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          btn.click();
        }
      });

      bodyEl.appendChild(btn);
      this._registry.set(id, {
        ref: new WeakRef(btn),
        bodyRef: new WeakRef(bodyEl),
      });
    }

    /**
     * Re-render every registered button to reflect current storage state.
     * Also prunes entries whose DOM nodes have been garbage-collected.
     */
    refreshAll() {
      for (const [id, entry] of this._registry) {
        const btn = entry.ref.deref();
        if (!btn || !btn.isConnected) {
          this._registry.delete(id);
          continue;
        }
        this._render(btn, this._storage.isCollected(id));
      }
    }

    /**
     * Check whether a body element already has a button registered.
     *
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
      const entry = this._registry.get(id);
      if (!entry) return false;

      const btn = entry.ref.deref();
      if (!btn || !btn.isConnected) {
        this._registry.delete(id);
        return false;
      }
      return true;
    }

    /**
     * Number of actively connected buttons.
     *
     * @returns {number}
     */
    get size() {
      return this._registry.size;
    }

    /**
     * Remove stale registry entries whose buttons are no longer in the DOM.
     */
    prune() {
      for (const [id, entry] of this._registry) {
        const btn = entry.ref.deref();
        if (!btn || !btn.isConnected) {
          this._registry.delete(id);
        }
      }
    }

    /* ── Private ─────────────────────────────────────────────────── */

    /**
     * Set a button's visual and ARIA state.
     *
     * @private
     * @param {HTMLButtonElement} btn
     * @param {boolean} collected
     */
    _render(btn, collected) {
      /* Clear existing icon. */
      while (btn.firstChild) btn.removeChild(btn.firstChild);

      if (collected) {
        btn.setAttribute('aria-label', 'Unmark as collected');
        btn.setAttribute('aria-checked', 'true');
        btn.title = 'Unmark as collected';
        btn.classList.add('collected');
        btn.appendChild(cloneIcon('check'));
      } else {
        btn.setAttribute('aria-label', 'Mark as collected');
        btn.setAttribute('aria-checked', 'false');
        btn.title = 'Mark as collected';
        btn.classList.remove('collected');
        btn.appendChild(cloneIcon('plus'));
      }
    }
  }

  /* ================================================================
   * 9. STYLE INJECTOR
   * ================================================================ */

  /**
   * Injects a <style> element with all extension CSS.
   * Uses CSS custom properties for per-site theming.
   * Idempotent — safe to call multiple times.
   */
  function injectStyles() {
    if (document.getElementById(CONFIG.STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = CONFIG.STYLE_ID;
    style.textContent = /* css */ `
      /* ── Theme tokens ──────────────────────────────────────── */
      :root {
        --fp-primary: ${SITE.color};
        --fp-primary-rgb: ${SITE.colorRgb};
        --fp-accent: #22c55e;
        --fp-accent-rgb: 34, 197, 94;
        --fp-surface: #181a20;
        --fp-surface-hover: #23262f;
        --fp-btn-size: 32px;
        --fp-icon-size: 18px;
        --fp-transition-speed: 0.18s;
      }

      /* ── Ensure positioning context for absolute button ───── */
      .drop-box-body {
        position: relative !important;
      }

      /* ── Base button ───────────────────────────────────────── */
      .fp-mark-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 100;
        width: var(--fp-btn-size);
        height: var(--fp-btn-size);
        padding: 0;
        border: 2px solid var(--fp-primary);
        border-radius: 50%;
        background: var(--fp-surface);
        color: inherit;
        font-size: 0;
        display: flex;
        justify-content: center;
        align-items: center;
        cursor: pointer;
        outline: none;
        user-select: none;
        pointer-events: auto;
        opacity: 0.97;
        backdrop-filter: blur(2px);
        box-shadow:
          0 0 10px 2px var(--fp-primary),
          0 0 0 0 var(--fp-primary);
        transition:
          background var(--fp-transition-speed),
          color var(--fp-transition-speed),
          border-color var(--fp-transition-speed),
          box-shadow var(--fp-transition-speed),
          transform var(--fp-transition-speed) cubic-bezier(0.4, 2, 0.3, 1);
      }

      /* ── Hover ─────────────────────────────────────────────── */
      .fp-mark-btn:hover {
        background: var(--fp-surface-hover);
        color: #fff;
        border-color: var(--fp-primary);
        box-shadow:
          0 0 18px var(--fp-primary),
          0 2px 12px rgba(var(--fp-primary-rgb), 0.18);
        transform: scale(1.08);
      }

      /* ── Focus-visible ─────────────────────────────────────── */
      .fp-mark-btn:focus-visible {
        outline: 2px solid var(--fp-primary);
        outline-offset: 2px;
      }

      /* ── Active (press) ────────────────────────────────────── */
      .fp-mark-btn:active {
        transform: scale(0.93);
        box-shadow: 0 0 8px var(--fp-primary);
      }

      /* ── Collected state ───────────────────────────────────── */
      .fp-mark-btn.collected {
        background: rgba(var(--fp-accent-rgb), 0.18);
        color: var(--fp-accent);
        border-color: var(--fp-accent);
        opacity: 1;
        box-shadow:
          0 0 24px var(--fp-accent),
          0 0 0 3px rgba(var(--fp-accent-rgb), 0.15);
        animation: fp-btn-pulse-green var(--fp-transition-speed) ease-out;
      }

      /* ── SVG icons ─────────────────────────────────────────── */
      .fp-icon {
        width: var(--fp-icon-size);
        height: var(--fp-icon-size);
        fill: currentColor;
        display: block;
      }

      .fp-plus {
        color: var(--fp-primary);
      }

      .fp-check {
        color: var(--fp-accent);
      }

      /* ── Pulse animation ───────────────────────────────────── */
      @keyframes fp-btn-pulse-green {
        0%   { box-shadow: 0 0 0 0 var(--fp-accent); }
        50%  { box-shadow: 0 0 0 12px rgba(var(--fp-accent-rgb), 0.27); }
        100% {
          box-shadow:
            0 0 24px var(--fp-accent),
            0 0 0 3px rgba(var(--fp-accent-rgb), 0.27);
        }
      }

      /* ── Reduced motion ────────────────────────────────────── */
      @media (prefers-reduced-motion: reduce) {
        .fp-mark-btn,
        .fp-mark-btn:hover,
        .fp-mark-btn:active {
          transition: none;
        }
        .fp-mark-btn.collected {
          animation: none;
        }
      }
    `;

    document.head.appendChild(style);
  }

  /* ================================================================
   * 10. DROP SCANNER
   * ================================================================ */

  /**
   * Observes the DOM for new `.drop-box-body` elements and delegates
   * button creation to `ButtonFactory`.
   *
   * On pages with no active drops (e.g. Twitch right now) the scanner
   * runs a single sweep, finds nothing, and skips observer setup.
   */
  class DropScanner {
    /**
     * @param {ButtonFactory} buttonFactory
     * @param {StorageController} storage
     */
    constructor(buttonFactory, storage) {
      /** @private */
      this._buttons = buttonFactory;

      /** @private */
      this._storage = storage;

      /** @private @type {MutationObserver|null} */
      this._observer = null;

      /** @private @type {ReturnType<typeof setTimeout>|null} */
      this._debounceTimer = null;

      /** @private */
      this._mutationsPaused = false;

      /** @private @type {WeakSet<Element>} */
      this._processedBodies = new WeakSet();
    }

    /**
     * Run the initial scan and, if drops exist, start observing for
     * dynamically inserted items.
     *
     * @returns {Promise<void>}
     */
    async start() {
      await this._scan();

      const hasDrop = document.querySelector(CONFIG.BODY_SELECTOR) !== null;
      if (hasDrop) {
        this._observe();
        Logger.info(
          `Monitoring ${IS_KICK ? 'Kick' : 'Twitch'} drops page` +
          ` (${this._buttons.size} item(s) found).`,
        );
      } else {
        Logger.info(
          `No active drops detected on ${IS_KICK ? 'Kick' : 'Twitch'}.` +
          ' Observer not started.',
        );
      }
    }

    /** Stop the observer and clear pending debounces. */
    destroy() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
    }

    /* ── Private ─────────────────────────────────────────────────── */

    /**
     * Debounced entry-point called by the MutationObserver callback.
     *
     * @private
     */
    _scheduleRescan() {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = null;
        await this._scan();
      }, CONFIG.DEBOUNCE_MS);
    }

    /**
     * Walk all `.drop-box-body` elements and inject a button if one
     * hasn't been attached already.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _scan() {
      await this._storage.init();

      /* Prune stale registry entries before scanning. */
      this._buttons.prune();

      const bodies = document.querySelectorAll(CONFIG.BODY_SELECTOR);
      if (bodies.length === 0) return;

      this._mutationsPaused = true;

      for (const body of bodies) {
        if (this._processedBodies.has(body)) continue;

        const id = ItemIdentifier.extract(body);
        if (id === null) {
          Logger.debug('Skipping item — could not determine stable ID.');
          continue;
        }

        if (this._buttons.has(id)) {
          Logger.debug(`Duplicate ID "${id}" — skipping.`);
          continue;
        }

        this._buttons.create(body, id);
        this._processedBodies.add(body);
      }

      this._mutationsPaused = false;
    }

    /**
     * Attach a MutationObserver on `document.body`.
     *
     * @private
     */
    _observe() {
      if (this._observer) return;

      this._observer = new MutationObserver(() => {
        if (this._mutationsPaused) return;
        this._scheduleRescan();
      });

      this._observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }

  /* ================================================================
   * 11. BOOTSTRAP
   * ================================================================ */

  /**
   * Wire everything together and kick off the extension.
   */
  async function init() {
    Logger.info(`Initialising on ${IS_KICK ? 'kick' : 'twitch'}.facepunch.com`);

    /* 1. Inject styles first so buttons render correctly on paint. */
    injectStyles();

    /* 2. Build the dependency graph. */
    const buttonFactory = new ButtonFactory(/** placeholder */ null);

    const storage = new StorageController(() => {
      /* Called when another tab writes to sync storage. */
      buttonFactory.refreshAll();
    });

    /* Patch the factory's storage reference now that it exists. */
    /** @type {any} */ (buttonFactory)._storage = storage;

    /* 3. Initialise storage cache. */
    await storage.init();
    storage.startListening();

    /* 4. Scan for drops and start observing. */
    const scanner = new DropScanner(buttonFactory, storage);
    await scanner.start();

    /* 5. Cleanup on unload. */
    window.addEventListener('beforeunload', () => {
      scanner.destroy();
    });
  }

  /* ── Entry-point ────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
