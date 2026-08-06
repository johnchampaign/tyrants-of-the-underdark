// Minimal browser globals so src/App.tsx (and the components it pulls in) can
// be imported and server-rendered from a headless vite-node script, without
// adding a jsdom dependency.
//
// This is deliberately tiny: react-dom/server never touches the DOM, so the
// only browser APIs we need are the ones module-level / render-time code reads
// (localStorage flags, window.location.search, window.matchMedia).
//
// Import this BEFORE importing anything from src/.

const store = new Map<string, string>();

const g = globalThis as unknown as Record<string, unknown>;

const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

if (!g.localStorage) g.localStorage = localStorageShim;

if (!g.window) {
  g.window = {
    location: { search: '', pathname: '/', href: 'http://localhost/', origin: 'http://localhost' },
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    localStorage: g.localStorage,
    addEventListener() { }, removeEventListener() { },
    setTimeout, clearTimeout, setInterval, clearInterval,
    devicePixelRatio: 1,
    innerWidth: 1280, innerHeight: 900,
    scrollTo() { },
  };
}

if (!g.document) {
  g.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() { }, appendChild() { } }),
    addEventListener() { }, removeEventListener() { },
    body: { appendChild() { }, removeChild() { }, style: {} },
    documentElement: { style: {} },
  };
}

if (!g.navigator) g.navigator = { userAgent: 'node', clipboard: { writeText: async () => { } } };
if (!g.indexedDB) g.indexedDB = { open: () => ({ addEventListener() { } }) };

/** Set one of the app's localStorage feature flags (e.g. SPLIT_VIEW_KEY). */
export function setStoredFlag(key: string, on: boolean): void {
  store.set(key, on ? '1' : '0');
}
