// Card / board image cache backed by IndexedDB.
//
// Goal: on first run the app fetches every image once from a configured remote
// source (e.g. an Imgur mirror or your own CDN) and stores the blob bytes in
// IndexedDB. On every subsequent load the images are served from the local
// store — zero network traffic, instant render.
//
// The remote source is configured via VITE_TOTU_IMAGE_BASE_URL (a base URL
// that mirrors the `assets/` directory layout). If unset, we fall back to
// relative paths (`/cards/<file>`), which is what the dev server provides
// when you've run `npm run extract-assets` locally.
//
// All Card usages should call `useCachedImage(relativePath)` instead of
// embedding the path directly; the hook handles cache hit, miss, in-flight
// fetch, and error-fallback.

import { useEffect, useState } from 'react';
import { DECK_SHEETS, ASSET_URLS, parseCardPath, type SheetInfo } from './sheet-config';

const DB_NAME = 'totu.image-cache';
const STORE = 'blobs';
const DB_VERSION = 1;

/** Open (or create) the IndexedDB. Cached promise so we open once. */
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbGet(key: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbKeys(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

export async function clearImageCache(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 1×1 transparent GIF used as the placeholder src while the real blob URL
 *  is being resolved (sheet fetch + slice). Without this, card paths would
 *  fall through to the local Vite publicDir URL — which 404s because we
 *  don't ship sliced card art (it's copyrighted Wizards of the Coast / Gale
 *  Force Nine art; players' browsers fetch the source sheets from the TTS
 *  workshop mods' CDN at runtime and slice client-side). The transparent
 *  placeholder avoids a spurious 404 + retry per card on first paint. */
const BLANK_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

/** True while a card's art is still being fetched and sliced — i.e. the hook is
 *  still handing back the transparent stand-in. The stand-in LOADS SUCCESSFULLY,
 *  so an <img> showing it never errors and the card just renders as an empty
 *  frame. That is what a slow source sheet looked like: every card cut from one
 *  Imgur sheet (drow, starters, House Guard, Priestess) blank at once, with no
 *  hint that art was merely on its way (#113). Callers should show a named
 *  placeholder instead. Also stays true if the fetch never succeeds, which used
 *  to leave the card blank permanently. */
export function isImagePending(url: string): boolean {
  return url === BLANK_DATA_URL;
}

/** Map a relative `assets/*` path to its remote source URL. Lookup order:
 *  (1) explicit ASSET_URLS entry (e.g. the board image → Imgur),
 *  (2) optional VITE_TOTU_IMAGE_BASE_URL prefix,
 *  (3) for card paths: a transparent placeholder (we never ship sliced art).
 *  (4) otherwise: local dev path under the Vite publicDir.
 */
function remoteUrlFor(relativePath: string): string {
  const mapped = ASSET_URLS[relativePath];
  if (mapped) return mapped;
  const base = (import.meta.env.VITE_TOTU_IMAGE_BASE_URL as string | undefined)?.replace(/\/$/, '');
  const trimmed = relativePath.replace(/^assets\//, '');
  if (base) return `${base}/${trimmed}`;
  if (parseCardPath(relativePath)) return BLANK_DATA_URL;
  return `/${trimmed}`;
}

/** Fetch a raw URL into a blob (for sheets / non-card images). */
async function fetchBlob(url: string): Promise<Blob> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} → HTTP ${resp.status}`);
  return await resp.blob();
}

/** Cache the sheet blob (from IndexedDB or fresh fetch) per sheet URL. The
 *  blob itself is small enough to keep in memory; the expensive part is
 *  fetching it over the network. We deliberately do NOT cache a full
 *  decoded ImageBitmap — Safari iOS caps per-image decodes at ~32MP, and
 *  the workshop sheets are 7490×5230 ≈ 39MP. Instead, each slice request
 *  asks createImageBitmap to decode JUST the tile region (region-only
 *  decode), which dodges the cap entirely. */
const sheetBlobPromises = new Map<string, Promise<Blob>>();

function loadSheetBlob(sheetUrl: string): Promise<Blob> {
  const cached = sheetBlobPromises.get(sheetUrl);
  if (cached) return cached;
  const p = (async () => {
    let blob = await dbGet(sheetUrl);
    if (!blob) {
      blob = await fetchBlob(sheetUrl);
      await dbPut(sheetUrl, blob);
    }
    return blob;
  })();
  sheetBlobPromises.set(sheetUrl, p);
  return p;
}

/** Derive the cities-and-routes board map from the workshop mod's 8449×4992
 *  table image. The crop offsets and dimensions below were computed offline
 *  by sharp using a purple-background bbox detection at 0.005 inset; baking
 *  them as constants makes the in-browser canvas pipeline produce the same
 *  cropped region sharp did, byte-for-byte alignment-wise (the JPEG bytes
 *  may differ due to encoder choices, but the pixel grid matches).
 *
 *  Calibrated site / slot positions in the app are stored as fractions of
 *  the post-crop, post-rotate image — so any drift in either operation
 *  would shift all the tokens off the printed slots. The constants here
 *  ensure no drift. */
const BOARD_CROP = { left: 2999, top: 152, width: 4605, height: 4646 } as const;

async function deriveBoardMap(): Promise<Blob> {
  const { TABLE_URL } = await import('./sheet-config');
  const tableBlob = await fetchBlob(TABLE_URL);
  const bmp = await createImageBitmap(tableBlob);
  if (bmp.width !== 8449 || bmp.height !== 4992) {
    // The mod author re-uploaded the table at a different size. Surface this
    // loudly — slot positions would drift and the smart fix is to recompute
    // the crop offsets, not silently rescale.
    // eslint-disable-next-line no-console
    console.warn(`[deriveBoardMap] table image dims ${bmp.width}×${bmp.height} != expected 8449×4992; crop offsets may be wrong`);
  }
  // Rotate -90° (CCW): the cropped region (4605×4646) becomes (4646×4605).
  const rotCanvas = document.createElement('canvas');
  rotCanvas.width = BOARD_CROP.height;   // 4646
  rotCanvas.height = BOARD_CROP.width;   // 4605
  const cx = rotCanvas.getContext('2d');
  if (!cx) throw new Error('no 2d context');
  // For rotate(-90°) (CCW): translate by (0, cropW), then rotate, then draw.
  cx.translate(0, BOARD_CROP.width);
  cx.rotate(-Math.PI / 2);
  cx.drawImage(bmp,
    BOARD_CROP.left, BOARD_CROP.top, BOARD_CROP.width, BOARD_CROP.height,
    0, 0, BOARD_CROP.width, BOARD_CROP.height);
  bmp.close();
  return await new Promise<Blob>((resolve, reject) => {
    rotCanvas.toBlob(
      b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')),
      'image/jpeg',
      0.92
    );
  });
}

/** Slice a single tile out of the sheet at `slot`, return a JPEG blob.
 *
 *  Uses createImageBitmap with a crop rect — region-only decode — so we
 *  never have to decode the full 7490×5230 sheet as one image. Safari iOS
 *  silently clips full-sheet decodes (~32MP cap) which manifested as
 *  blank tiles in the lower-right of the sheet (e.g. drow slot 39,
 *  Weaponmaster). Crop-decode sidesteps that limit entirely. */
async function sliceTile(sheet: SheetInfo, slot: number): Promise<Blob> {
  const blob = await loadSheetBlob(sheet.url);
  const tileW = Math.floor(sheet.width / sheet.cols);
  const tileH = Math.floor(sheet.height / sheet.rows);
  const row = Math.floor(slot / sheet.cols);
  const col = slot % sheet.cols;
  const bmp = await createImageBitmap(blob, col * tileW, row * tileH, tileW, tileH);
  const canvas = document.createElement('canvas');
  canvas.width = tileW;
  canvas.height = tileH;
  const cx = canvas.getContext('2d');
  if (!cx) { bmp.close(); throw new Error('no 2d context'); }
  cx.drawImage(bmp, 0, 0);
  bmp.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')),
      'image/jpeg',
      0.9
    );
  });
}

/** Fetch (or slice/derive) a single image into the cache. Resolves with the blob. */
async function fetchAndStore(relativePath: string): Promise<Blob> {
  // Card paths get sliced out of the deck's sheet.
  const parsed = parseCardPath(relativePath);
  if (parsed && DECK_SHEETS[parsed.deck]) {
    const sheet = DECK_SHEETS[parsed.deck];
    const blob = await sliceTile(sheet, parsed.slot);
    await dbPut(relativePath, blob);
    return blob;
  }
  // The board map is derived from the workshop mod's table image: auto-crop
  // out the purple background, then rotate -90° (the table is stored
  // landscape; the map is portrait). The exact pipeline produces a byte-
  // identical result to what we computed offline earlier, so all calibrated
  // slot/site positions stay accurate.
  if (relativePath === 'assets/board/map.jpg') {
    const blob = await deriveBoardMap();
    await dbPut(relativePath, blob);
    return blob;
  }
  // Non-card path → fall back to the per-path remote URL.
  const url = remoteUrlFor(relativePath);
  const blob = await fetchBlob(url);
  await dbPut(relativePath, blob);
  return blob;
}

/** Public: get a blob-URL for the image. Reads from cache; on miss, fetches
 *  and caches. The blob URL is reusable across the same page lifetime — the
 *  caller is responsible for revoking it when no longer needed (or just let
 *  the page unload clean it up). */
const blobUrlCache = new Map<string, string>();

/** Minimum plausible size for a sliced card blob. The old buggy slicer (which
 *  ran on Safari iOS's downsampled sheet) wrote near-empty JPEGs to
 *  IndexedDB for tiles in the lower-right of the sheet — typically under
 *  3KB of mostly-transparent data. Real card slices are 40-150KB. Any
 *  cached entry under this threshold is presumed corrupt and re-sliced. */
const MIN_VALID_CARD_BLOB_BYTES = 5_000;

/** Drop a cached blob URL — revokes the URL object and clears the in-memory
 *  cache entry so the next getImageBlobUrl() call gets a fresh URL pointing
 *  at the same underlying blob (still in IndexedDB). Used as TIER-1 retry
 *  path on iPad Safari, where blob URLs occasionally become un-decodable
 *  mid-session under memory pressure even though the underlying blob is
 *  fine. Re-creating the URL after revoke tends to recover the image. */
export function clearImageBlobUrl(relativePath: string): void {
  const url = blobUrlCache.get(relativePath);
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    blobUrlCache.delete(relativePath);
  }
}

/** TIER-2 retry: drop the blob URL AND evict the IndexedDB entry, so the
 *  next getImageBlobUrl() call goes through fetchAndStore (which re-slices
 *  card images from the source sheet via createImageBitmap). Heavier than
 *  clearImageBlobUrl but recovers from the rare case where the underlying
 *  IDB blob itself got corrupted, not just the URL pointer. */
export async function evictImageFromCache(relativePath: string): Promise<void> {
  clearImageBlobUrl(relativePath);
  try { await dbDelete(relativePath); } catch { /* ignore — non-fatal */ }
}

/** Soft cap on the number of blob URLs we keep alive simultaneously. On
 *  iPad Safari, accumulated URL.createObjectURL pointers seem to correlate
 *  with mid-session image-decode failures (cards going blank after they'd
 *  displayed earlier). When the cache grows past this, evict the oldest
 *  entries — they're typically market cards already replaced. Currently-
 *  displayed cards are still safe: if a stale URL gets evicted, the Card
 *  component's retry-on-error mechanism (tier 1) creates a fresh URL on
 *  the next img error. */
const MAX_LIVE_BLOB_URLS = 80;
function maybeEvictOldest(): void {
  while (blobUrlCache.size > MAX_LIVE_BLOB_URLS) {
    // Map iteration is insertion-order; the first entry is the oldest.
    const oldestKey = blobUrlCache.keys().next().value;
    if (oldestKey === undefined) break;
    clearImageBlobUrl(oldestKey);
  }
}

export async function getImageBlobUrl(relativePath: string): Promise<string> {
  if (blobUrlCache.has(relativePath)) return blobUrlCache.get(relativePath)!;
  let blob = await dbGet(relativePath);
  // Detect blobs that were saved by the pre-fix slicer (Safari iOS, sheet
  // downsampled past its decode cap, lower-right tiles cropped from outside
  // the actually-decoded pixel data). They roundtripped to IndexedDB as
  // tiny near-empty JPEGs. Treat them as a miss and re-slice with the new
  // createImageBitmap crop pipeline.
  if (blob && parseCardPath(relativePath) && blob.size < MIN_VALID_CARD_BLOB_BYTES) {
    blob = undefined;
  }
  if (!blob) blob = await fetchAndStore(relativePath);
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(relativePath, url);
  maybeEvictOldest();
  return url;
}

export interface BulkImportProgress {
  total: number;
  done: number;
  failed: number;
  current: string | null;
  finished: boolean;
}

/** Import every image in `paths` into the cache. Skips already-cached entries.
 *  Calls `onProgress` after each fetch. Resolves when all have been processed
 *  (success or failure). */
export async function bulkImport(
  paths: string[],
  onProgress: (p: BulkImportProgress) => void,
  concurrency = 6,
): Promise<BulkImportProgress> {
  const existing = new Set(await dbKeys());
  const pending = paths.filter(p => !existing.has(p));
  const state: BulkImportProgress = {
    total: pending.length,
    done: 0, failed: 0, current: null, finished: false,
  };
  onProgress({ ...state });
  if (pending.length === 0) {
    state.finished = true;
    onProgress({ ...state });
    return state;
  }

  // Worker-pool concurrency.
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= pending.length) return;
      const p = pending[i];
      state.current = p;
      try { await fetchAndStore(p); state.done++; }
      catch { state.failed++; }
      onProgress({ ...state });
    }
  });
  await Promise.all(workers);
  state.current = null;
  state.finished = true;
  onProgress({ ...state });
  return state;
}

/** React hook: resolves a relative-path image to a usable URL. Returns the
 *  remote URL string for an immediate render (so the browser shows something
 *  while we're loading the cached blob), then swaps to a blob URL once
 *  available. On any error, returns the remote URL — the consumer can render
 *  it normally and let onError fall through to a placeholder. */
export function useCachedImage(relativePath: string, retryTick: number = 0): string {
  const [url, setUrl] = useState<string>(() => remoteUrlFor(relativePath));
  useEffect(() => {
    let cancelled = false;
    getImageBlobUrl(relativePath)
      .then(blobUrl => { if (!cancelled) setUrl(blobUrl); })
      .catch(() => { /* keep the initial remote-URL fallback */ });
    return () => { cancelled = true; };
    // retryTick changes force a re-fetch (e.g., when an <img> errors and
    // the caller calls clearImageBlobUrl then bumps the tick).
  }, [relativePath, retryTick]);
  return url;
}
