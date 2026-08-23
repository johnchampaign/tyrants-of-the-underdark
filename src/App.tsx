import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Client } from 'boardgame.io/react';
import type { BoardProps } from 'boardgame.io/react';
import { recordPlay } from 'digital-boardgame-framework';
import { TyrantsGame, BASE_ACTION_POWER_COST, COLORS, SELECTABLE_COLORS, type TyrantsState, type CardRef, type Color } from './game';
import { MapView } from './components/MapView';
import { CardCalibration } from './components/CardCalibration';
import { CostVerify } from './components/CostVerify';
import { SiteVerify } from './components/SiteVerify';
import { SlotCalibration } from './components/SlotCalibration';
import { SectionDividerCalibration } from './components/SectionDividerCalibration';
import { MarkerCalibration } from './components/MarkerCalibration';
import { HALF_DECKS, EXPANSION_HALF_DECKS, type HalfDeck } from './half-decks';
import { GameLog } from './components/GameLog';
import { GameTabLog } from './components/GameTabLog';
import { CardLogText } from './components/CardLogText';
import { CardTextVerify } from './components/CardTextVerify';
import { RouteVerify } from './components/RouteVerify';
import { ProblemReportDialog } from './components/ProblemReportDialog';
import { FirstRunImageImport } from './components/FirstRunImageImport';
import { PlaceholderCard } from './components/PlaceholderCard';
import { useCachedImage, clearImageBlobUrl, evictImageFromCache } from './image-cache';
import { cardWhiffReason } from './engine/card-targets';
import { logLineText } from './engine/log';
import { SITES } from './data/sites';
import { sitesSpaces, TROOP_SPACES } from './data/troop-spaces';
import { hasPresence, checkTokenConservation } from './engine/map-state';
import { publishGameLog } from './publish-game-log';
import { archiveGame, getAllArchivedGames, payloadForArchivedGame } from './game-archive';
import { LogUploadConsentDialog } from './components/LogUploadConsentDialog';
import { BugFixResponseDialog } from './components/BugFixResponseDialog';
import { fetchUnseenFixNotes, markFixNoteSeen, type FixNoteUpdate } from './bug-report-tracker';
import { capturePageScreenshot } from './screenshot';
import { decideAiMove, type AiMove } from './ai/random-ai';
import { decideHeuristicMove, decideHeuristicMoveWithWeights } from './ai/heuristic-ai';
import { DEFAULT_WEIGHTS } from './ai/heuristic-weights';
import type { SimulateMoveFn, RolloutToTurnEndFn } from './ai/lookahead';
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import { lookupCard } from './card-data';
import { scoreAll } from './engine/scoring';

const HUMAN_SEAT = '0';

// ---------------------------------------------------------------------------
// Board mode seam (hotseat vs online)
// ---------------------------------------------------------------------------
//
// The Board component below is shared between hotseat (the bgio Client) and
// online play (OnlinePlay.tsx feeds it a BoardProps-shaped object backed by the
// framework's useGame/submit). Everything mode-specific is funneled through
// this context so the component body stays a single implementation:
//
//   - `mySeat`   — which seat the local human controls. Hotseat is always '0'
//                  (HUMAN_SEAT); online it's the seat the server assigned
//                  (useGame's `you`). Every former `HUMAN_SEAT` reference inside
//                  Board now reads this instead, so the same JSX renders the
//                  active player's controls regardless of which seat they hold.
//   - `isOnline` — gates off every hotseat-only side effect: the local AI driver
//                  loop, localStorage save/load, archive, publish, dev-log, and
//                  beforeunload. Online, the server is authoritative and the
//                  opponents are remote humans; a client must only drive its own
//                  seat (integration-guide "Porting an existing hotseat game").
//   - `onlineError` — useGame's `error`, surfaced inside the board chrome so a
//                  rejected submit is visible even under a full-screen prompt.
//
// The DEFAULT is hotseat (`isOnline:false, mySeat:'0'`), so the existing bgio
// Client path that renders <Board/> WITHOUT a provider is byte-for-byte
// unchanged in behavior.
interface BoardMode {
  isOnline: boolean;
  mySeat: string;
  onlineError?: Error | null;
  // ONLINE only: submit a problem report as a SINGLE write to the framework
  // store (Supabase `dbf_reports`, dbf@0.4.0). The server-side ReportForwarder
  // (GitHubIssueForwarder) then files the canonical GitHub issue — so triage
  // still lives in one place (GitHub Issues), but the GitHub call is no longer
  // a separate client request. The `category` is a coarse, player-friendly
  // symptom bucket; the forwarder maps 'multiplayer' -> the `area:multiplayer`
  // label so framework-class bugs are filterable/routable. Returns the
  // framework report id. Hotseat leaves this undefined, so ProblemReportDialog
  // runs its existing GitHub/relay path unchanged.
  reportProblem?: (
    message: string,
    opts?: { category?: OnlineReportCategory },
  ) => Promise<string>;
}
/** Coarse symptom bucket chosen by the player in the online report dialog. */
export type OnlineReportCategory = 'game' | 'multiplayer' | 'other';

/** Small colored chip so players can identify/pick opponents by colour at a
 *  glance instead of memorising which colour is P2/P3/P4 (#66). */
function ColorSwatch({ color, size = 11 }: { color: string; size?: number }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: 2,
      // Flat gradient (a background-IMAGE) instead of a solid background-color so
      // Samsung Internet / Chrome Android "Website dark mode" can't repaint this
      // player-colour swatch. Looks identical to a solid fill everywhere else.
      background: `linear-gradient(${color}, ${color})`, border: '1px solid rgba(255,255,255,0.6)',
      marginRight: 6, verticalAlign: 'middle', flexShrink: 0,
    }} />
  );
}
/** "Red (P2)" with a leading colour swatch — colour first, since that's how
 *  players think about opponents. */
function playerColorLabel(color: string, pid: string) {
  const name = color.charAt(0).toUpperCase() + color.slice(1);
  return <><ColorSwatch color={color} />{name} (P{Number(pid) + 1})</>;
}
export const BoardModeContext = createContext<BoardMode>({ isOnline: false, mySeat: HUMAN_SEAT });

const AI_THINK_MS = 400;
const SAVE_KEY = 'totu.savegame';
const CONFIG_KEY = 'totu.gameconfig';
const DEV_KEY = 'totu.dev-mode';
const NO_IMAGES_KEY = 'totu.no-images';
const SPLIT_VIEW_KEY = 'totu.split-view';
const SKIP_SUMMARIES_KEY = 'totu.skip-turn-summaries';

// Bulk "Upload logs": archived games already uploaded successfully are recorded
// here (by their IndexedDB id) so later uploads skip them instead of re-sending
// every record every time (#62). The relay also de-dupes server-side by content
// hash; this just avoids the redundant client-side round-trips.
const UPLOADED_LOGS_KEY = 'totu.uploaded-logs';
function loadUploadedLogIds(): Set<number> {
  try { return new Set(JSON.parse(localStorage.getItem(UPLOADED_LOGS_KEY) ?? '[]') as number[]); }
  catch { return new Set(); }
}
function markLogUploaded(id: number): void {
  const s = loadUploadedLogIds();
  s.add(id);
  try { localStorage.setItem(UPLOADED_LOGS_KEY, JSON.stringify([...s])); } catch { /* quota — ignore */ }
}

function readUrlBoolFlag(param: string, storageKey: string): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has(param)) {
      const val = params.get(param) === '1' || params.get(param) === 'true';
      localStorage.setItem(storageKey, val ? '1' : '0');
      return val;
    }
    return localStorage.getItem(storageKey) === '1';
  } catch { return false; }
}

/** Read dev-mode from URL (?dev=1 / ?dev=0) and persist in localStorage. The URL
 *  param takes precedence and updates the stored value; otherwise we honor the
 *  stored flag. Visiting the app fresh shows only player-facing tabs. */
function initialDevMode(): boolean {
  return readUrlBoolFlag('dev', DEV_KEY);
}

/** No-images mode (?no-images=1 / ?no-images=0). When on, the first-run image
 *  import gate is skipped and the Card component renders text-only
 *  placeholders. Lets users play the game without ever fetching art, and lets
 *  the dev exercise the placeholder UI without clearing the image cache. */
export function isNoImagesMode(): boolean {
  return readUrlBoolFlag('no-images', NO_IMAGES_KEY);
}

/** Split-view mode (?split-view=1 / ?split-view=0). When on, a new "play"
 *  tab becomes available that shows the map and the hand+market strip on
 *  the same page — map on top, cards below, with hover-to-expand. Per
 *  user feedback on the forum: "I wonder if it would be possible to
 *  somehow have your hand of cards and the market on the same 'page' as
 *  the map." Off by default; the existing game/map tabs stay unchanged. */
export function isSplitViewMode(): boolean {
  return readUrlBoolFlag('split-view', SPLIT_VIEW_KEY);
}

/** Skip the between-turns summary (?skip-summaries=1 / =0). The modal exists so
 *  you can see what happened while you weren't looking, but against AI seats
 *  that's a click after every single opponent turn, and by mid-game a lot of
 *  players stop reading it. Requested on the forum: "would it be possible to
 *  add option (toggle on/off) to skip the AI bot log actions... sometimes I
 *  don't care what they do."
 *
 *  Nothing is lost when it's on — the same lines are in the log tab, and each
 *  turn is still listed under the Log tab's per-turn breakdown. Off by default:
 *  online it's the only way to see a remote opponent's turn at all. */
export function isSkipSummariesMode(): boolean {
  return readUrlBoolFlag('skip-summaries', SKIP_SUMMARIES_KEY);
}

// Difficulty tiers exposed in the new-game dialog. 'easy' is the same
// heuristic as 'standard', but with the rollout-lookahead disabled — that
// difference alone is worth ~28 pp of win-rate (rollout-on vs rollout-off
// tournament measurement) and roughly tracks the pre/post change in
// browser-game win rates against humans (~8% vs ~32%). 'standard' is the
// current default. We deliberately don't call it "hard" — it still loses
// ~2/3 of games to a competent human; truly hard would need deeper
// lookahead or opponent-reply modeling.
type AiStyle = 'random' | 'easy' | 'heuristic';

type ThirdPlayerSide = 'left' | 'right';
interface GameConfig {
  numPlayers: number;
  /** AI style for seats 1..N-1 (seat 0 is the human). */
  aiStyles: AiStyle[];
  /** Exactly 2 half-decks chosen for the market. */
  halfDecks: HalfDeck[];
  /** For 3-player games only: which outer section plays alongside the center.
   *  Ignored for 2-player (center only) and 4-player (all three sections). */
  thirdPlayerSide?: ThirdPlayerSide;
  /** Colour the human (seat 0) plays. Remaining colours go to the AI seats.
   *  Undefined → default seat order (black, red, orange, blue). */
  humanColor?: Color;
}
const AI_FNS: Record<AiStyle, (G: TyrantsState, pid: string) => AiMove | null> = {
  random: decideAiMove,
  // 'easy' and 'heuristic' both use the heuristic AI; the lookahead toggle
  // is handled inside the AI driver (see useEffect calling decideHeuristic
  // MoveWithWeights). These entries are here so the Record type is total.
  easy: decideHeuristicMove,
  heuristic: decideHeuristicMove,
};

/** Rulebook p.5: 2P = center only; 3P = center + one outer; 4P = all three. */
function activeSectionsFor(cfg: GameConfig): Array<'left' | 'center' | 'right'> {
  if (cfg.numPlayers <= 2) return ['center'];
  if (cfg.numPlayers === 3) return ['center', cfg.thirdPlayerSide ?? 'left'];
  return ['left', 'center', 'right'];
}

interface SessionCtx {
  config: GameConfig;
  onNewGame: () => void;
}
const SessionContext = createContext<SessionCtx | null>(null);

/** True when the primary input can hover — i.e. mouse / trackpad. False on
 *  touch-only devices like iPad / phones. We use this to gate the card
 *  enlarge-on-hover effect: on touch devices, tapping to recruit a card
 *  was leaving the next card pre-enlarged because the synthetic mouseenter
 *  that fires after a tap stayed latched on the slot under the player's
 *  finger. Evaluated once at module load; the result is stable for the
 *  session — if a user pairs a bluetooth mouse mid-game they'd need a
 *  reload to re-enable hover-scaling, which is an acceptable trade. */
const HOVER_CAPABLE =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: hover)').matches;

function Card({ card, onClick, label, dim }: { card: CardRef; onClick?: () => void; label?: string; dim?: boolean }) {
  const [hover, setHover] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  // transformOrigin is recomputed on each hover-enter so the 2.5x enlarge
  // stays inside the viewport — cards near a screen edge would otherwise
  // scale outward into invisible space. We clamp the origin fraction
  // (ox, oy) so the scaled card's bounding box fits within the viewport.
  const cardRef = useRef<HTMLDivElement | null>(null);
  // On hover-enter we capture the card's viewport rect + a clamped
  // transformOrigin. The enlarged card is then rendered as a sibling with
  // position:fixed at that rect — that escapes any ancestor overflow:auto
  // (e.g. SplitPlayView's cards section, which was clipping the enlarge).
  // Per problem-reports #34 (off-screen) and #36 (still clipped after the
  // first fix that only adjusted transformOrigin).
  const [hoverGeom, setHoverGeom] = useState<{ rect: DOMRect; origin: string } | null>(null);
  const computeHoverGeom = () => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const scale = 2.5;
    const k = scale - 1;
    const vw = window.innerWidth, vh = window.innerHeight;
    // For a card scaled by `scale` around origin fraction ox in [0,1]
    // (0=left edge of card, 1=right edge), the scaled bounding box's
    // left = r.left + r.width*ox*(1-scale), right = left + r.width*scale.
    // Solve left>=0 → ox <= r.left/(r.width*k); right<=vw → ox >= (r.left+r.width*scale-vw)/(r.width*k).
    const oxMin = Math.max(0, (r.left + r.width * scale - vw) / (r.width * k));
    const oxMax = Math.min(1, r.left / (r.width * k));
    const oyMin = Math.max(0, (r.top + r.height * scale - vh) / (r.height * k));
    const oyMax = Math.min(1, r.top / (r.height * k));
    const ox = oxMin > oxMax ? 0.5 : Math.min(oxMax, Math.max(oxMin, 0.5));
    const oy = oyMin > oyMax ? 0.5 : Math.min(oyMax, Math.max(oyMin, 0.5));
    setHoverGeom({ rect: r, origin: `${(ox * 100).toFixed(1)}% ${(oy * 100).toFixed(1)}%` });
  };
  // retryTick bumps after an <img> errors mid-session; useCachedImage
  // refetches when this changes. Caps at 1 so a genuinely broken image
  // doesn't loop forever — second failure falls through to placeholder.
  // Per iPad bug reports (#19, #29): blob URLs can become un-decodable
  // mid-session under memory pressure even though IndexedDB still has the
  // bytes; revoke + recreate recovers reliably.
  const [retryTick, setRetryTick] = useState(0);
  const imgUrl = useCachedImage(card.image, retryTick);
  // Reset the failed flag whenever the URL changes. useCachedImage starts
  // out returning the virtual /cards/<deck>/<slot>-<slug>.jpg path which
  // 404s on a static host like GH Pages (no such file exists — it's a
  // logical path serviced by the slice cache). The 404 fires onError →
  // imgFailed=true → PlaceholderCard. A few hundred ms later useCachedImage
  // resolves the actual blob URL via createImageBitmap-on-cached-sheet,
  // but the latched imgFailed kept us stuck on the placeholder. Resetting
  // here gives the resolved blob URL a fresh try; if it ALSO fails (real
  // network error) onError will re-set the flag.
  useEffect(() => { setImgFailed(false); }, [imgUrl]);
  const handleImgError = () => {
    // Stamp a retry event into localStorage so the next problem-report
    // can show whether the retry path fired and which tier it reached.
    // Bounded log (keep last 50 events) so we don't fill quota.
    try {
      const raw = localStorage.getItem('totu.img-retry-log');
      const arr = raw ? (JSON.parse(raw) as Array<{ t: number; path: string; tier: number }>) : [];
      arr.push({ t: Date.now(), path: card.image, tier: retryTick });
      if (arr.length > 50) arr.splice(0, arr.length - 50);
      localStorage.setItem('totu.img-retry-log', JSON.stringify(arr));
    } catch { /* localStorage may be full / unavailable — non-fatal */ }

    if (retryTick === 0) {
      // TIER 1: revoke the cached blob URL and create a fresh one from the
      // same IndexedDB blob. Handles the common iPad case where the URL
      // pointer broke but the underlying bytes are fine.
      clearImageBlobUrl(card.image);
      setRetryTick(1);
    } else if (retryTick === 1) {
      // TIER 2: also evict the IndexedDB entry and re-slice from the source
      // sheet via createImageBitmap. Handles the rarer case where the IDB
      // blob itself is corrupt (old-slicer leftovers, partial write, etc.).
      evictImageFromCache(card.image).finally(() => setRetryTick(2));
    } else {
      // Both recovery tiers failed — fall through to placeholder.
      setImgFailed(true);
    }
  };
  // No-images mode forces the placeholder regardless of cache state. Also
  // falls back to placeholder if the image actually 404s at runtime.
  const showPlaceholder = isNoImagesMode() || imgFailed;
  // Touch-only devices: never set hover from synthetic mouse events, so the
  // post-tap enlarge bug can't fire. The visual stays the same as the
  // resting state.
  const onMouseEnter = HOVER_CAPABLE ? () => { computeHoverGeom(); setHover(true); } : undefined;
  const onMouseLeave = HOVER_CAPABLE ? () => { setHover(false); setHoverGeom(null); } : undefined;
  return (
    <div
      ref={cardRef}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        width: 120, margin: 4, borderRadius: 8,
        cursor: onClick ? 'pointer' : 'default',
        background: '#1a1228',
        position: 'relative',
        opacity: dim ? 0.35 : 1,
        filter: dim ? 'grayscale(1)' : undefined,
        transition: 'opacity 120ms ease, filter 120ms ease',
      }}
      title={card.name}
    >
      {/* In-flow card at scale 1 — always present so the layout stays stable. */}
      {showPlaceholder ? (
        <PlaceholderCard card={card} hover={false} />
      ) : (
        <img
          key={`${card.image}|${retryTick}`}
          src={imgUrl}
          alt={card.name}
          onError={handleImgError}
          onLoad={(e) => { if (e.currentTarget.naturalWidth === 0) handleImgError(); }}
          style={{
            width: '100%', display: 'block', borderRadius: 8,
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
          }}
        />
      )}
      {/* Enlarged overlay: position:fixed so it escapes any ancestor
          overflow:auto (e.g. SplitPlayView cards section). Origin is
          clamped so the 2.5x bounding box stays inside the viewport. */}
      {hover && hoverGeom && (
        <div style={{
          position: 'fixed',
          top: hoverGeom.rect.top, left: hoverGeom.rect.left,
          width: hoverGeom.rect.width, height: hoverGeom.rect.height,
          transform: 'scale(2.5)',
          transformOrigin: hoverGeom.origin,
          zIndex: 1000,
          pointerEvents: 'none',
          boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
          borderRadius: 8,
        }}>
          {showPlaceholder ? (
            <PlaceholderCard card={card} hover={false} />
          ) : (
            <img src={imgUrl} alt={card.name}
                 style={{ width: '100%', display: 'block', borderRadius: 8 }} />
          )}
        </div>
      )}
      {label && <div style={{ padding: '2px 6px', fontSize: 11, opacity: 0.8 }}>{label}</div>}
    </div>
  );
}

type BaseAction = null | { kind: 'deploy' | 'assassinate' } | { kind: 'return-spy'; siteId?: string };

export function Board({ G, ctx, moves }: BoardProps<TyrantsState>) {
  const session = useContext(SessionContext);
  const [tab, setTab] = useState<'play' | 'game' | 'map' | 'calibrate' | 'routes' | 'cards' | 'costs' | 'text' | 'sites' | 'whites' | 'slots' | 'dividers' | 'markers' | 'log'>('game');
  // Split-view as React state so toggling doesn't need a page reload (which
  // would surprise the user mid-setup — no game state on disk yet → back
  // to the game-selection dialog). Initialized from localStorage; the
  // toggle button below writes both state and storage in lockstep.
  const [splitView, setSplitView] = useState<boolean>(isSplitViewMode);
  const [skipSummaries, setSkipSummaries] = useState<boolean>(isSkipSummariesMode);
  // No-images mode as React state so the toggle can flip it WITHOUT a page
  // reload. The old toggle called window.location.reload(), which ran the
  // resume-from-save path and (via loadState keeping the fresh-mount snapshots)
  // could poison the save and reset the game back to setup — the reported bug.
  // Card / MapView / the preload gate read isNoImagesMode() (localStorage) at
  // render; bumping this state re-renders the Board subtree so they pick up the
  // new value with no reload.
  const [noImages, setNoImages] = useState<boolean>(isNoImagesMode);
  const [baseAction, setBaseAction] = useState<BaseAction>(null);
  // Which opponent's spy to return, when a site holds more than one. Local UI
  // state rather than an engine prompt: the returnEnemySpy move already takes a
  // target colour, so the engine has nothing to decide.
  const [spyPick, setSpyPick] = useState<{ siteId: string; colors: string[] } | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  // Which of the player's own card piles is open in the inspector overlay,
  // if any. Lets a player review what's in their deck / discard / inner
  // circle for planning (#68). The deck is shown UNORDERED (sorted by
  // deck+slot) so it isn't a peek at draw order.
  const [pileView, setPileView] = useState<'deck' | 'discard' | 'inner' | 'trophy' | 'played' | null>(null);
  // Which player's pile the overlay is showing. null = the local viewer (me).
  // Opponents' discard / inner circle / trophy hall are public info, so any
  // player can be inspected from the scoreboard (#82, Drew W.). Deck and hand
  // stay private and are never offered for opponents.
  const [pilePlayer, setPilePlayer] = useState<string | null>(null);
  // "Play all basic": when true, the driver effect auto-plays non-interactive
  // hand cards one at a time until none remain (#66).
  const [playingAll, setPlayingAll] = useState(false);
  // After the final score, let players go back and look at the board. Tyrants
  // stays close until the last turn, and half the fun afterwards is comparing
  // how each strategy filled the map — but the game-over screen used to replace
  // the whole board, so the moment you could finally discuss it was the moment
  // it disappeared.
  const [reviewingBoard, setReviewingBoard] = useState(false);
  // Auto-captured screenshot for the bug report. Grabbed BEFORE the dialog
  // mounts so it shows the actual game state, not the modal overlay.
  const [reportScreenshot, setReportScreenshot] = useState<string | null>(null);
  // Bulk-upload status: 'idle' default, 'uploading' while POSTing, 'done'
  // briefly after to show counts to the user. Auto-clears via setTimeout.
  const [bulkUpload, setBulkUpload] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading'; progress: string }
    | { kind: 'done'; uploaded: number; deduped: number; failed: number; skipped: number }
  >({ kind: 'idle' });
  // Pending consent: when the user clicks Upload logs we count the records
  // first, open the disclosure dialog, and only kick off the actual POST
  // loop after they confirm.
  const [pendingConsent, setPendingConsent] = useState<{ recordCount: number } | null>(null);
  // Queue of fix-note updates fetched from the relay on mount. We surface
  // them one at a time via BugFixResponseDialog; dismissing one shifts the
  // next into view and persists the seen-marker in localStorage so neither
  // pops up on the next load.
  const [fixNoteQueue, setFixNoteQueue] = useState<FixNoteUpdate[]>([]);

  // Poll once per app mount for closed bug reports with a "Fix note"
  // comment the player hasn't seen yet. The poll is a single network call
  // (worker dedups + filters server-side); failures are silent so the
  // thank-you flow can't break gameplay.
  useEffect(() => {
    let cancelled = false;
    fetchUnseenFixNotes().then(updates => {
      if (!cancelled && updates.length > 0) setFixNoteQueue(updates);
    });
    return () => { cancelled = true; };
  }, []);

  function dismissCurrentFixNote() {
    setFixNoteQueue(prev => {
      const [head, ...rest] = prev;
      if (head) markFixNoteSeen(head.number, head.commentCreatedAt);
      return rest;
    });
  }
  const [devMode, setDevModeState] = useState<boolean>(initialDevMode);
  const setDevMode = (v: boolean) => {
    setDevModeState(v);
    try { localStorage.setItem(DEV_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

  // Restore the most-recent saved snapshot once on mount (resume after reload).
  // Saved games are cleared by the "New game" button and when the game ends.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (isOnline) return; // server is the source of truth; never restore a local save
    if (loadedRef.current) return;
    loadedRef.current = true;
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved && G.snapshots.length <= 1 && !G.endGameTriggeredAtTurn) {
      try { moves.loadState(saved); } catch { /* corrupted save — ignore */ }
    }
  }, [G.snapshots.length, G.endGameTriggeredAtTurn, moves]);

  // Persist the latest snapshot codec on every turn boundary. Clear on gameover.
  //
  // CRITICAL: we skip the very first invocation. On mount, both useEffects fire on
  // the same render — the load effect dispatches loadState (async, lands next
  // render), but the save effect would otherwise immediately write the fresh
  // setup codec into localStorage, clobbering the real saved game. By skipping
  // the first save we preserve the existing save until the load completes; the
  // first real write happens once loadState lands and snapshots grows.
  const firstSaveRef = useRef(true);
  useEffect(() => {
    if (isOnline) return; // online games persist server-side; don't touch localStorage
    if (firstSaveRef.current) { firstSaveRef.current = false; return; }
    if (ctx.gameover) { localStorage.removeItem(SAVE_KEY); return; }
    if (G.snapshots.length === 0) return;
    // Don't persist during setup. bgio's play order is re-randomized on
    // page refresh (G.firstPlayerId is regenerated in setup()), so a saved
    // mid-setup codec would resume with a mismatched currentPlayer — the
    // human's starting deploy would silently skip and an AI would deploy
    // for the wrong seat (Issue #24). Clearing here also lets a fresh-page
    // load start a new setup cleanly.
    if (G.setupPhase) { localStorage.removeItem(SAVE_KEY); return; }
    const latest = G.snapshots[G.snapshots.length - 1].codec;
    localStorage.setItem(SAVE_KEY, latest);
  }, [G.snapshots.length, G.setupPhase, ctx.gameover]);

  // Best-effort archive on page unload (tab close, refresh, navigate away).
  // IndexedDB writes are not guaranteed to flush before the page is killed,
  // but in practice browsers give the write a brief window — and since this
  // is purely additive (it can't lose data, only fail to capture some), it's
  // worth attempting. Skip when the game is in setup phase (nothing useful
  // to capture) or has reached gameover (already archived in the gameover
  // effect below).
  useEffect(() => {
    if (isOnline) return; // archiving is a hotseat affordance; online state lives server-side
    function onUnload() {
      if (!session) return;
      if (G.setupPhase) return;
      if (ctx.gameover) return;
      // Fire-and-forget. We don't await; the browser may kill us mid-write.
      void archiveGame(G, {
        numPlayers: Object.keys(G.players).length,
        halfDecks: session.config.halfDecks,
        aiStyles: session.config.aiStyles,
      });
    }
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [G, ctx.gameover, session]);

  // On game-over: archive the completed game locally (IndexedDB) AND attempt
  // an auto-publish to the public log relay. The archive is the authoritative
  // local copy; auto-publish is best-effort. If it fails (network hiccup, no
  // relay URL configured, etc.), the user can re-submit later via the bulk
  // "Upload logs" button in the header — the relay's SHA256 dedup means
  // duplicate uploads are no-ops server-side, so we can be loose about
  // retries.
  const publishedRef = useRef(false);
  useEffect(() => {
    if (isOnline) return; // online games are archived/published by the server pipeline, not the client
    if (!ctx.gameover) return;
    if (publishedRef.current) return;
    publishedRef.current = true;
    const context = {
      numPlayers: Object.keys(G.players).length,
      halfDecks: session?.config.halfDecks ?? [],
      aiStyles: session?.config.aiStyles ?? [],
    };
    archiveGame(G, context).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[archive-game] failed:', err);
    });
    publishGameLog(G, { ...context, source: 'browser-game' }).then(r => {
      if (r.ok) {
        // eslint-disable-next-line no-console
        console.info('[publish-game-log]', r.deduped ? 'deduped' : 'published', r.path ?? r.filePath, r.htmlUrl ?? '');
      } else {
        // eslint-disable-next-line no-console
        console.warn('[publish-game-log] failed:', r.error);
      }
    });
  }, [ctx.gameover, G, session]);

  // Dev-only: mirror the live game log to disk via the vite plugin endpoint.
  // Lets the developer (or an assistant) read the current state without manual
  // copy/paste. Writes on every state mutation (including silent INVALID_MOVE
  // failures, which don't grow the log) so a vanished-deploy / failed-action
  // can be diagnosed after the fact.
  useEffect(() => {
    const violations = checkTokenConservation(G);
    if (violations.length > 0) {
      const lastEntry = G.log[G.log.length - 1];
      const lastLog = lastEntry ? logLineText(lastEntry) : '(no log entries)';
      for (const v of violations) {
        const sign = v.delta > 0 ? '+' : '';
        // eslint-disable-next-line no-console
        console.warn(
          `[TOKEN CONSERVATION] ${v.color}: ${sign}${v.delta} ` +
          `(actual ${v.actual} vs expected ${v.expected}) — ` +
          `onBoard=${v.breakdown.onBoard}, ` +
          `trophies=${JSON.stringify(v.breakdown.trophies)}, ` +
          `barracks=${JSON.stringify(v.breakdown.barracks)} — ` +
          `turn ${ctx.turn} P${Number(ctx.currentPlayer) + 1} — last log: ${lastLog}`
        );
      }
    }
    const payload = {
      writtenAt: new Date().toISOString(),
      turn: ctx.turn,
      currentPlayer: ctx.currentPlayer,
      gameover: ctx.gameover ?? null,
      tokenConservation: violations.length === 0 ? 'ok' : violations,
      log: G.log,
      turnLogs: G.turnLogs,
      snapshots: G.snapshots,
      pendingChoice: G.pendingChoice,
      pausedHandlerState: G.pausedHandlerState,
      setupPhase: G.setupPhase,
      // Map state — useful for diagnosing "the spy/troop didn't appear" bugs.
      troops: Object.fromEntries(Object.entries(G.troops).filter(([, v]) => v != null)),
      spies: Object.fromEntries(Object.entries(G.spies).filter(([, arr]) => arr.length > 0)),
      siteControl: Object.fromEntries(Object.entries(G.siteControl).filter(([, v]) => v != null)),
      controlMarkers: Object.fromEntries(Object.entries(G.controlMarkers).filter(([, m]) => m.holder != null)),
      players: Object.fromEntries(Object.entries(G.players).map(([pid, p]) => [pid, {
        color: p.color, vp: p.vp, power: p.power, influence: p.influence,
        barracksLeft: p.barracksLeft, handSize: p.hand.length,
        deckSize: p.deck.length, discardSize: p.discard.length,
        innerCircleSize: p.innerCircle.length,
        trophies: p.trophyHall,
        hand: p.hand.map(c => c.name),
      }])),
    };
    if (import.meta.env.DEV) {
      fetch('/__save-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => { /* ignore — endpoint only exists in dev */ });
    }
  }, [G.log.length, ctx.turn, ctx.currentPlayer, ctx.gameover, G, G.log, G.turnLogs, G.snapshots, G.pendingChoice, G.players]);
  // Hotseat: P1 ('0') is the human and the UI renders from their perspective;
  // P2..PN are AI. Online: `mySeat` is the seat the server assigned this client,
  // and `isOnline` turns off the local AI driver + persistence side effects.
  const { isOnline, mySeat, onlineError, reportProblem } = useContext(BoardModeContext);
  const me = mySeat;
  const p = G.players[me];
  const myTurn = ctx.currentPlayer === me;
  // The seat that's actually acting right now: a pending choice's owner takes
  // precedence over the nominal turn player. Used for the online "whose turn"
  // banner. Reuses each player's engine-assigned color for the display label.
  const currentActor = G.pendingChoice?.playerId ?? ctx.currentPlayer;
  const showOpponentTurnBanner = isOnline && currentActor !== me;
  const opponentColor = showOpponentTurnBanner ? G.players[currentActor]?.color : undefined;
  const opponentTurnLabel = opponentColor
    ? `${opponentColor.charAt(0).toUpperCase()}${opponentColor.slice(1)} is taking their turn`
    : undefined;
  // The local AI drives every seat that isn't the local human's — but ONLY in
  // hotseat. Online, every other seat is a remote human, so there is no AI turn.
  const isAiTurn = !isOnline && ctx.currentPlayer !== me;
  const aiHasPendingChoice = !isOnline && !!G.pendingChoice && G.pendingChoice.playerId !== me;

  // Per-AI-turn summary modal. The user clicks through each AI's completed turn to
  // see what they did before play continues to the next seat.
  //
  // On (re)load, start PAST the backlog: only surface opponent turns that
  // completed since our own last turn (usually just the one, in a 2-player game),
  // not the entire game's history. Reloading a mid-game — which happens a lot,
  // especially while something's misbehaving — otherwise forces the player to
  // click through a modal for every opponent turn from the start. New opponent
  // turns that complete while we're actually playing still surface normally.
  const [shownTurnLogCount, setShownTurnLogCount] = useState(() => {
    let lastMine = -1;
    for (let i = 0; i < G.turnLogs.length; i++) if (G.turnLogs[i].playerId === me) lastMine = i;
    return lastMine + 1;
  });
  // Find the next AI-turn log we haven't shown yet. We track the absolute index so
  // OK can jump the counter past it (skipping any interleaved human turns), instead
  // of just incrementing by 1 and forcing the user to click through the gap.
  const pendingAiSummaryIdx = (() => {
    // Hotseat: this clicks through what each local AI (or other hotseat seat) did.
    // Online: there are no AI turns, but you also can't watch your remote opponent
    // play — so the SAME modal is exactly what's needed to show the opponent's
    // completed turn(s) once control returns to you. In both modes the rule is
    // identical: surface the next turnLog that isn't mine and that I haven't
    // already seen. `shownTurnLogCount` (advanced past on OK) makes this
    // poll-safe: re-renders while it's still the opponent's turn just re-find the
    // same index until a new completed-turn log appears; clicking OK jumps the
    // counter past it so it never re-shows. (Phase 3 disabled this online when it
    // was wrongly assumed to be AI-only; the opponent-turn-summary need is real.)
    for (let i = shownTurnLogCount; i < G.turnLogs.length; i++) {
      if (G.turnLogs[i].playerId !== me) return i;
    }
    return -1;
  })();
  const pendingAiSummary = (pendingAiSummaryIdx >= 0 && !skipSummaries)
    ? G.turnLogs[pendingAiSummaryIdx] : null;
  const showingModal = !!pendingAiSummary;

  // While skipping, keep the counter moving past each opponent turn as it
  // completes. Suppressing the modal without advancing would bank a backlog and
  // dump every skipped turn on the player the moment they switched it back on.
  useEffect(() => {
    if (!skipSummaries || pendingAiSummaryIdx < 0) return;
    setShownTurnLogCount(pendingAiSummaryIdx + 1);
  }, [skipSummaries, pendingAiSummaryIdx]);

  // Reducer + template state for the heuristic AI's 1-ply / turn-end lookahead,
  // ALSO used by the "Play all basic" dry-run (basicPlayIdx below).
  // The reducer is reused across every counterfactual call; closures `simulate`
  // and `rollout` below (and basicPlayIdx) splice the LIVE G + ctx into the
  // template state for each reducer call, so lookahead reflects current play.
  //
  // Available online too: previously this returned null without a session
  // (online has no SessionContext), which silently disabled Play-all in
  // multiplayer (#70). The session only ever supplied setup inputs (halfDecks /
  // numPlayers), and setup is invoked solely to build the throwaway `template`
  // — whose G/ctx are DISCARDED at every use site in favour of the live state.
  // So we can build it from the live ctx.numPlayers; halfDecks only seeds the
  // discarded template market, so a default is harmless when no session exists.
  const aiLookahead = useMemo(() => {
    type AnyState = { G: TyrantsState; ctx: typeof ctx & { gameover?: unknown } };
    type AnyReducer = (s: AnyState, action: unknown) => AnyState;
    const numPlayers = session?.config.numPlayers ?? ctx.numPlayers ?? 2;
    const halfDecks = session?.config.halfDecks ?? ['drow', 'dragons'];
    const wrappedGame = {
      ...TyrantsGame,
      setup: (sa: Parameters<NonNullable<typeof TyrantsGame.setup>>[0]) =>
        TyrantsGame.setup!(sa, { halfDecks }),
    };
    const reducer = CreateGameReducer({ game: wrappedGame }) as unknown as AnyReducer;
    const template = InitializeGame({ game: wrappedGame, numPlayers }) as unknown as AnyState;
    return { reducer, template };
  }, [session, ctx.numPlayers]);

  // AI driver: dispatch one move per state tick whenever it's an AI seat's turn
  // (or an AI has a pending choice). State updates re-run this effect, so the AI keeps
  // playing until control returns to P1. Paused while a turn-summary modal is open so
  // the user has time to read each AI's actions.
  useEffect(() => {
    if (showingModal) return;
    if (!isAiTurn && !aiHasPendingChoice) return;
    const handle = setTimeout(() => {
      // When the prompt is for an AI player but it isn't their turn (e.g.
      // a forced-discard triggered by the human's card targets an AI), use
      // the *prompted* player's seat for AI decision-making — not the
      // current player's seat.
      const aiPid = aiHasPendingChoice && G.pendingChoice!.playerId
        ? G.pendingChoice!.playerId
        : ctx.currentPlayer;
      const seatIdx = Number(aiPid);
      const style = session?.config.aiStyles[seatIdx - 1] ?? 'random';
      let decided: AiMove | null = null;
      if (style === 'heuristic' && aiLookahead) {
        // Build simulate + rollout closures that hand the AI the boardgame.io
        // reducer for counterfactual play. Without these the heuristic falls
        // back to pure-score ranking (no chooseOne fix, no rollout) — that's
        // a big strength loss. See replay-divergence and rollout-vs-no-lookahead
        // tournament results for the magnitude (+28pp).
        const { reducer, template } = aiLookahead;
        const action = (type: string, args: unknown[], pid: string) =>
          ({ type: 'MAKE_MOVE', payload: { type, args, playerID: pid } });
        const simulate: SimulateMoveFn = (Gx, pid, name, args) => {
          const wrapped = { ...template, G: Gx, ctx: { ...ctx, currentPlayer: pid } };
          const next = reducer(wrapped, action(name, args, pid));
          if (next === wrapped) return null;
          return next.G;
        };
        const rollout: RolloutToTurnEndFn = (Gx, pid, name, args) => {
          let s = { ...template, G: Gx, ctx: { ...ctx, currentPlayer: pid } };
          s = reducer(s, action(name, args, pid));
          if (s.G === Gx) return null;
          let inner = 50;
          while (inner-- > 0) {
            if (s.ctx.gameover) break;
            if (s.ctx.currentPlayer !== pid) break;
            const m = decideHeuristicMoveWithWeights(s.G, pid, DEFAULT_WEIGHTS);
            if (!m) { s = reducer(s, action('endTurn', [], pid)); continue; }
            const next = reducer(s, action(m.name, m.args as unknown[], pid));
            if (next === s) s = reducer(s, action('endTurn', [], pid));
            else s = next;
          }
          return s.G;
        };
        decided = decideHeuristicMoveWithWeights(G, aiPid, DEFAULT_WEIGHTS, simulate, rollout);
      } else if (style === 'easy') {
        // Easy tier: heuristic with lookahead disabled. The useLookahead
        // weight is respected by the AI's lookahead-aware code paths, so
        // setting it to 0 collapses the AI to pre-rollout strength (which
        // beat humans ~8% of the time vs ~32% for the standard tier).
        const easyWeights = { ...DEFAULT_WEIGHTS, useLookahead: 0 };
        decided = decideHeuristicMoveWithWeights(G, aiPid, easyWeights);
      } else {
        const decide = AI_FNS[style] ?? decideAiMove;
        decided = decide(G, aiPid);
      }
      if (!decided) return;
      const fn = (moves as Record<string, (...args: unknown[]) => void>)[decided.name];
      if (typeof fn === 'function') fn(...decided.args);
    }, AI_THINK_MS);
    return () => clearTimeout(handle);
  }, [G, ctx, isAiTurn, aiHasPendingChoice, moves, showingModal, session, aiLookahead]);

  // "Play all basic" — index of the first hand card whose effect is
  // NON-interactive (playing it opens no prompt). We can't know that statically,
  // so we dry-run the play through the same bgio reducer the AI uses and check
  // whether it leaves a pendingChoice. Works online too (#70): the dry-run is a
  // pure reducer call on the live G; online, moves.playCard routes through the
  // server like any other move. null = nothing basic to play right now.
  const basicPlayIdx = useMemo<number | null>(() => {
    if (!aiLookahead || !myTurn || G.pendingChoice || G.setupPhase || ctx.gameover) return null;
    const { reducer, template } = aiLookahead;
    const action = (type: string, args: unknown[], pid: string) =>
      ({ type: 'MAKE_MOVE', payload: { type, args, playerID: pid } });
    const hand = G.players[me]?.hand ?? [];
    for (let i = 0; i < hand.length; i++) {
      const wrapped = { ...template, G, ctx } as { G: TyrantsState; ctx: typeof ctx };
      const next = reducer(wrapped, action('playCard', [i], me)) as { G: TyrantsState };
      if (next === wrapped) continue;        // invalid (shouldn't happen on your turn)
      // 1. Skip a card that would FIZZLE — e.g. Mind Flayer / Marilith played as
      // your last card, where "devour a card from hand" has no food left. It
      // opens no prompt, so the naive check below would treat it as a free
      // basic and auto-play it for zero effect (#74). Leave it for the player.
      if ((next.G as unknown as { _playFizzledNoFood?: boolean })._playFizzledNoFood) continue;
      // NEW FIX CONDITIONS:
      // 2. Skip cards that created an immediate prompt
      if (next.G.pendingChoice) continue;
      // 3. Skip cards that queued up an End-of-Turn promote trigger
      const currentEotCount = G.pendingEotPromotions?.length ?? 0;
      const nextEotCount = next.G.pendingEotPromotions?.length ?? 0;
      if (nextEotCount > currentEotCount) continue;

      return i; // Safely confirmed as a non-interactive basic card
      }
    return null;
  }, [isOnline, aiLookahead, myTurn, G, ctx, me]);

  // Driver: while Play-all is armed and it's a clean human turn, play one basic
  // card per tick (small delay so the user sees them go). Stops when none remain
  // or the turn state changes. Online, each playCard is fire-and-forget: G only
  // updates after the server round-trip + useGame refetch, which re-runs this
  // effect (deps include G) and plays the next basic card — one per round-trip.
  //
  // The naive version stopped on the FIRST `basicPlayIdx == null`. Online that
  // is fatal: between dispatching a play and the server's reply, G is unchanged
  // and React still re-renders (transport polling churns the `moves` identity),
  // so the effect re-runs while the move is in flight. Any blip — or simply
  // re-running before the reply lands — let the old code either re-dispatch the
  // same card (double-play) or, on a transient null, latch playingAll=false and
  // stall after a single card (#71 / #80). We now gate on a per-dispatch
  // signature: after we fire a playCard we record the state we played FROM, and
  // we neither re-dispatch nor stop until the state actually moves past it (the
  // reply landed). The signature folds in hand contents, the cards-played count
  // and deck size, so it strictly advances on every real play even when the card
  // also draws a replacement of the same type. Hot-seat is unaffected: there the
  // reply is synchronous, so the signature changes on the very next render.
  const playAllSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!playingAll) { playAllSigRef.current = null; return; }
    // Hard stops: the turn is genuinely over, or input is required.
    if (isAiTurn || ctx.gameover || !myTurn || G.setupPhase || G.pendingChoice) {
      playAllSigRef.current = null;
      setPlayingAll(false);
      return;
    }
    const hand = G.players[me]?.hand ?? [];
    const deckLen = G.players[me]?.deck.length ?? 0;
    const sig = `${hand.map(c => `${c.deck}:${c.slot}`).join(',')}|${G.cardsPlayedThisTurn.length}|${deckLen}`;
    // Our last auto-play hasn't landed yet (online round-trip): the next G sync
    // re-runs this effect. Don't re-dispatch, and crucially don't stop.
    if (playAllSigRef.current === sig) return;
    // State has settled / advanced past our last play.
    playAllSigRef.current = null;
    if (basicPlayIdx == null) { setPlayingAll(false); return; }  // no basics left → done
    const h = setTimeout(() => {
      playAllSigRef.current = sig;   // remember the state we just played FROM
      moves.playCard(basicPlayIdx);
    }, 140);
    return () => clearTimeout(h);
  }, [playingAll, basicPlayIdx, isAiTurn, myTurn, me, G, ctx, moves]);

  // Human-facing pending choices that drive map UI.
  const humanSitePick = G.pendingChoice
    && G.pendingChoice.kind === 'select-site'
    && G.pendingChoice.playerId === me
    ? G.pendingChoice : null;
  const humanSpacePick = G.pendingChoice
    && G.pendingChoice.kind === 'select-troop-space'
    && G.pendingChoice.playerId === me
    ? G.pendingChoice : null;
  const humanMarketPick = G.pendingChoice
    && G.pendingChoice.kind === 'select-market-card'
    && G.pendingChoice.playerId === me
    ? G.pendingChoice : null;
  const humanMapPick = humanSitePick || humanSpacePick;
  const clickableMarketSlots = humanMarketPick
    ? new Set((humanMarketPick.options as number[] | undefined) ?? [])
    : null;

  // Keep `tab` consistent with the current `splitView` mode.
  // - Turning ON split view: 'game' / 'map' tabs hide from the bar, so move
  //   the user to 'play' if they were on one of those.
  // - Turning OFF split view: the 'play' tab hides, so move the user to
  //   'game' (the dashboard view) instead of leaving them on a hidden tab
  //   that silently fails to render — user-reported.
  useEffect(() => {
    if (splitView && (tab === 'game' || tab === 'map')) setTab('play');
    else if (!splitView && tab === 'play') setTab('game');
  }, [splitView, tab]);

  // Auto-focus the map tab whenever the human needs to click something on the board.
  // In split-view mode the play tab ALREADY has the map visible, so leave the
  // user there instead of yanking them away — the whole point of split view is
  // a single screen with both map and cards.
  useEffect(() => {
    if ((G.setupPhase && myTurn) || humanMapPick || baseAction) {
      if (splitView) {
        if (tab !== 'play') setTab('play');
      } else if (tab !== 'map') {
        setTab('map');
      }
    }
  }, [G.setupPhase, myTurn, humanMapPick, baseAction, tab, splitView]);

  // Auto-focus the card view whenever a prompt fires that can only be
  // resolved from the card piles / hand (end-of-turn promote, devour-from-
  // discard / inner-circle, forced hand discard). Those render on the game
  // tab (or the play tab in split view), NOT the map tab — so a player who
  // clicks End Turn while looking at the map would otherwise have to flip
  // back manually to promote. Pull them there automatically. Reported as
  // suggestion #68: "auto-go to the promote screen on End Turn." The map-
  // click prompts (select-site/-troop-space) are handled by the map-focus
  // effect above; choose-one / select-player resolve inline via the prompt
  // bar, so neither needs a switch here.
  useEffect(() => {
    const pc = G.pendingChoice;
    if (!pc || pc.playerId !== me) return;
    const cardPileKinds = [
      'select-played-card', 'select-card-in-discard',
      'select-card-in-inner-circle', 'select-card-in-hand',
      'select-market-card',
    ];
    if (!cardPileKinds.includes(pc.kind)) return;
    if (splitView) {
      if (tab !== 'play') setTab('play');
    } else if (tab === 'map' || tab === 'log') {
      setTab('game');
    }
  }, [G.pendingChoice, me, tab, splitView]);

  // Clear pending base action whenever it's no longer the human's turn or a card prompt fires.
  useEffect(() => {
    if (!myTurn || humanMapPick) setBaseAction(null);
  }, [myTurn, humanMapPick]);

  // Compute base-action eligibility on the fly.
  const baseActionClickableSites: Set<string> | undefined = (() => {
    if (!baseAction) return undefined;
    if (baseAction.kind === 'return-spy') {
      // Sites where you have presence AND an enemy spy is present.
      const out = new Set<string>();
      for (const s of SITES) {
        if (!hasPresence(G, p.color, { site: s.id })) continue;
        const spies = G.spies[s.id] ?? [];
        if (spies.some(c => c !== p.color)) out.add(s.id);
      }
      return out;
    }
    return undefined;
  })();
  const baseActionClickableSpaces: Set<string> | undefined = (() => {
    if (!baseAction || baseAction.kind === 'return-spy') return undefined;
    const out = new Set<string>();
    for (const t of TROOP_SPACES) {
      if (!(t.id in G.troops)) continue; // outside active sections
      const occ = G.troops[t.id];
      if (baseAction.kind === 'deploy') {
        if (occ) continue;
        if (t.parentSite && hasPresence(G, p.color, { site: t.parentSite })) out.add(t.id);
        else if (t.parentRoute && hasPresence(G, p.color, { space: t.id })) out.add(t.id);
      } else if (baseAction.kind === 'assassinate') {
        if (!occ || occ === p.color) continue;
        if (t.parentSite && hasPresence(G, p.color, { site: t.parentSite })) out.add(t.id);
        else if (t.parentRoute && hasPresence(G, p.color, { space: t.id })) out.add(t.id);
      }
    }
    return out;
  })();

  const startingClickable = G.setupPhase && myTurn
    // Per rulebook setup p.4: "Each player chooses one of the starting
    // sites that isn't already occupied by another player." White troops
    // printed at a starting site don't block it (the player drops into the
    // next empty slot) — but ANY non-white troop means a rival player has
    // already claimed it, so it's off-limits.
    ? new Set(SITES.filter(s =>
        s.isStartingSite && s.id in G.siteControl &&
        sitesSpaces(s.id).some(sp => !G.troops[sp.id]) &&
        !sitesSpaces(s.id).some(sp => G.troops[sp.id] && G.troops[sp.id] !== 'white')
      ).map(s => s.id))
    : humanSitePick
      ? new Set((humanSitePick.options as string[] | undefined) ?? SITES.map(s => s.id))
      : baseActionClickableSites;

  const clickableSpaces = humanSpacePick
    ? new Set((humanSpacePick.options as string[] | undefined) ?? [])
    : baseActionClickableSpaces;

  // Advisory subset of the clickable sites: the ones where the card's *next*
  // step (assassinate / supplant / the "opponent troop here" bonus) actually
  // has something to bite on. Every clickable site stays clickable — this only
  // changes how the ring is drawn. See PendingChoice.highlight (#105).
  const highlightSites = humanSitePick?.highlight
    ? new Set(humanSitePick.highlight as string[])
    : undefined;

  const handleSiteClick = (siteId: string) => {
    if (G.setupPhase && myTurn) { moves.deployStartingTroop(siteId); return; }
    if (humanSitePick) { moves.resolveChoice(siteId); return; }
    if (baseAction?.kind === 'return-spy') {
      const enemyColors = (G.spies[siteId] ?? []).filter(c => c !== p.color);
      if (enemyColors.length === 1) {
        moves.returnEnemySpy(siteId, enemyColors[0]);
        // Stay in return-spy mode; auto-cancelled by the power-watchdog effect.
      } else if (enemyColors.length > 1) {
        // Two opponents spying on the same site is a real decision — they
        // belong to different people, and returning the wrong one can hand the
        // site to whoever you were trying to block. This used to silently take
        // the first colour in the array (reported from BGG).
        setSpyPick({ siteId, colors: enemyColors });
      }
    }
  };
  const logClick = (kind: string, target: string, extras?: Record<string, unknown>) => {
    if (!import.meta.env.DEV) return; // dev-only telemetry; the endpoint 404s in prod
    fetch('/__log-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        at: new Date().toISOString(),
        turn: ctx.turn, currentPlayer: ctx.currentPlayer,
        kind, target,
        baseAction: baseAction?.kind ?? null,
        pendingChoice: G.pendingChoice ? { kind: G.pendingChoice.kind, prompt: G.pendingChoice.prompt } : null,
        power: p.power, barracksLeft: p.barracksLeft,
        ...extras,
      }),
    }).catch(() => { /* dev-only endpoint */ });
  };

  const handleSpaceClick = (spaceId: string) => {
    if (humanSpacePick) { logClick('resolveChoice/space', spaceId); moves.resolveChoice(spaceId); return; }
    // Stay in the chosen base-action mode after a successful click so the player can
    // chain deploys / assassinations without re-clicking the button. The mode is
    // auto-cleared by the useEffect below when power drops below the action's cost.
    if (baseAction?.kind === 'deploy') {
      logClick('deployTroop', spaceId, { occupant: G.troops[spaceId] ?? null });
      moves.deployTroop(spaceId);
      return;
    }
    if (baseAction?.kind === 'assassinate') {
      logClick('assassinateTroop', spaceId, { occupant: G.troops[spaceId] ?? null });
      moves.assassinateTroop(spaceId);
      return;
    }
    logClick('space-click-noop', spaceId);
  };

  // Auto-cancel sticky base-action mode when the player can no longer afford it.
  useEffect(() => {
    if (!baseAction) return;
    const cost = baseAction.kind === 'deploy' ? 1 : 3;
    if (p.power < cost) setBaseAction(null);
  }, [baseAction, p.power]);

  // Action bar — base actions + End Turn. Rendered in BOTH the map tab and the
  // game tab so the player can always Cancel sticky modes / switch actions
  // while looking at the map.
  const canDeploy = myTurn && p.power >= 1 && !G.pendingChoice;
  const canAssassinate = myTurn && p.power >= BASE_ACTION_POWER_COST && !G.pendingChoice;
  const canReturnSpy = myTurn && p.power >= BASE_ACTION_POWER_COST && !G.pendingChoice;
  const actionBtn = (label: string, enabled: boolean, active: boolean, onClick: () => void) => (
    <button onClick={onClick} disabled={!enabled}
      style={{
        padding: '6px 12px',
        background: active ? '#ffcc44' : '#2a1840',
        color: active ? '#000' : '#e6e1f2',
        border: '1px solid #3a2055', borderRadius: 4,
        cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.4,
      }}>{label}</button>
  );
  const deployLabel = p.barracksLeft <= 0 ? 'Deploy (1 Power → +1 VP)' : 'Deploy (1 Power)';
  // End-turn guard: resources reset each turn so unspent power / influence /
  // unplayed cards are wasted. Warn the player before ending — easy to bump
  // the End Turn button by accident, especially on touch. Skip the prompt
  // when nothing actionable is left so the common path stays fast.
  //
  // Influence check: warn only if the player can ACTUALLY afford something
  // right now — enumerate the market row + aux stacks (Priestess, House
  // Guard) against current influence. A leftover 1 influence with no
  // cost-1 card in the market shouldn't trigger the warning; a leftover
  // 1 influence with a Kobold (cost 1) in the market should.
  const canAffordAnyRecruit = (): boolean => {
    const inf = p.influence;
    for (const c of G.market.row) {
      if (!c) continue;
      const d = lookupCard(c.deck, c.slot);
      if (d && d.cost <= inf) return true;
    }
    const priestess = lookupCard('priestesses', 43);
    if (priestess && (G.auxStacks?.priestesses ?? 0) > 0 && priestess.cost <= inf) return true;
    const houseGuard = lookupCard('house-guards', 40);
    if (houseGuard && (G.auxStacks?.houseGuards ?? 0) > 0 && houseGuard.cost <= inf) return true;
    return false;
  };
  const handleEndTurn = () => {
    const reasons: string[] = [];
    if (p.hand.length > 0) reasons.push(`${p.hand.length} unplayed card${p.hand.length === 1 ? '' : 's'}`);
    if (p.power >= 1) reasons.push(`${p.power} unspent power`);
    if (p.influence > 0 && canAffordAnyRecruit()) {
      reasons.push(`${p.influence} unspent influence (you can afford at least one card)`);
    }
    if (reasons.length > 0) {
      const ok = window.confirm(
        `You have ${reasons.join(' and ')} remaining.\n\n` +
        `Resources don't carry over between turns. End turn anyway?`
      );
      if (!ok) return;
    }
    moves.endTurn();
  };

  // Wrap moves.playCard with a whiff check: if the card's primary effect
  // has no valid targets given current board state (e.g. Advance Scout
  // with no white troops where you have presence), confirm before
  // burning the play. The engine would otherwise silently log
  // "(supplant: no eligible targets — skipped)" and the card goes to
  // discard with no effect.
  const playCardSafe = (i: number) => {
    const card = p.hand[i];
    if (card) {
      const data = lookupCard(card.deck, card.slot);
      const reason = data ? cardWhiffReason(G, ctx.currentPlayer, data.effectKey) : null;
      if (reason) {
        const ok = window.confirm(
          `${card.name} has no valid targets right now (${reason}).\n\n` +
          `Play it anyway? The card's effect will be skipped and it'll go to your discard.`
        );
        if (!ok) return;
      }
    }
    moves.playCard(i);
  };

  // A compact "button-driven" prompt bar for pendingChoice kinds that aren't
  // resolved by clicking the map (choose-one, select-player). The full
  // game-tab prompt block has more context (the prompt header + the
  // resolve-by-clicking-map hint for select-site/space), but those click-
  // driven prompts work fine in the map tab via humanMapPick handling and
  // SplitPlayView's panel pickers. This bar is for the cases where the user
  // needs to push a button to resolve — without it the user is stuck on
  // map/play and has to flip back to the game tab. Reported on Intellect
  // Devourer's times(2, …) loops which surface a chooseOne each iteration.
  const interactivePromptBar = (() => {
    const pc = G.pendingChoice;
    if (!pc) return null;
    if (pc.playerId !== me) return null;
    if (pc.kind !== 'choose-one' && pc.kind !== 'select-player') return null;
    return (
      <div style={{ marginBottom: 8, padding: 10, background: '#3a2055', borderRadius: 4 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 6 }}>{pc.prompt}</div>
        {pc.kind === 'choose-one' && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {((pc.options as string[] | undefined) ?? []).map((label, i) => (
              <button key={i} onClick={() => moves.resolveChoice(i)}
                style={{ padding: '6px 12px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                {label}
              </button>
            ))}
          </div>
        )}
        {pc.kind === 'select-player' && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {((pc.options as string[] | undefined) ?? []).map(pid => (
              <button key={pid} onClick={() => moves.resolveChoice(pid)}
                style={{ padding: '6px 12px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                {playerColorLabel(G.players[pid].color, pid)}
              </button>
            ))}
          </div>
        )}
        {pc.optional && (
          <button onClick={() => moves.resolveChoice(null)} style={{ marginTop: 8, padding: '4px 12px', fontSize: 12 }}>
            Decline
          </button>
        )}
      </div>
    );
  })();

  // Whose spy? Shown when the clicked site holds spies from more than one
  // opponent. Mirrors the engine's select-player prompt styling so the two
  // routes to this action look the same.
  const spyPickBar = spyPick ? (() => {
    const siteName = SITES.find(s2 => s2.id === spyPick.siteId)?.name ?? spyPick.siteId;
    return (
      <div style={{ marginBottom: 8, padding: 10, background: '#3a2055', borderRadius: 4 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 6 }}>Return whose spy from {siteName}?</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {spyPick.colors.map(c => {
            const pid = Object.keys(G.players).find(k => G.players[k].color === c);
            return (
              <button key={c}
                onClick={() => { moves.returnEnemySpy(spyPick.siteId, c as Color); setSpyPick(null); }}
                style={{ padding: '6px 12px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                {pid ? playerColorLabel(G.players[pid].color, pid) : c}
              </button>
            );
          })}
        </div>
        <button onClick={() => setSpyPick(null)} style={{ marginTop: 8, padding: '4px 12px', fontSize: 12 }}>
          Cancel
        </button>
      </div>
    );
  })() : null;

  // Shown instead of the action bar once the game is over and the player has
  // stepped back into the board to look around.
  const reviewBanner = (ctx.gameover && reviewingBoard) ? (
    <div style={{ marginTop: 16, padding: 10, background: '#3a2055', borderRadius: 4,
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 'bold' }}>Game over — this is the final board.</span>
      <button onClick={() => setReviewingBoard(false)}
        style={{ padding: '6px 12px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
        ← Back to results
      </button>
    </div>
  ) : null;

  const actionBar = (
    <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
      {actionBtn(deployLabel, canDeploy, baseAction?.kind === 'deploy',
        () => setBaseAction(baseAction?.kind === 'deploy' ? null : { kind: 'deploy' }))}
      {actionBtn('Assassinate (3 Power)', canAssassinate, baseAction?.kind === 'assassinate',
        () => setBaseAction(baseAction?.kind === 'assassinate' ? null : { kind: 'assassinate' }))}
      {actionBtn('Return enemy spy (3 Power)', canReturnSpy, baseAction?.kind === 'return-spy',
        () => setBaseAction(baseAction?.kind === 'return-spy' ? null : { kind: 'return-spy' }))}
      {baseAction && actionBtn('Cancel', true, false, () => setBaseAction(null))}
      {(() => {
        const canPlayAll = myTurn && !G.pendingChoice && !G.setupPhase && basicPlayIdx != null;
        const active = canPlayAll && !playingAll;
        // While it's running the button becomes STOP. Once started there was no
        // way to interrupt it, which is how a player ended up auto-playing a
        // card whose cost is "devour a card from your hand" with nothing left to
        // devour — and online there's no undo to walk it back. Stopping only
        // ends the run; cards already played stay played.
        return (
          <button
            onClick={() => setPlayingAll(p => !p)}
            disabled={!active && !playingAll}
            title={playingAll
              ? 'Stop after the card currently being played. Cards already played stay played.'
              : 'Play every hand card whose effect needs no decision (e.g. resource cards), one after another. Stops when only cards that require a choice remain.'}
            style={{ padding: '8px 16px',
              background: playingAll ? '#5a2a2a' : active ? '#2a4a30' : '#2a2a2a',
              color: (active || playingAll) ? 'white' : '#777',
              border: 'none', borderRadius: 4,
              cursor: (active || playingAll) ? 'pointer' : 'not-allowed', marginLeft: 'auto' }}>
            {playingAll ? '■ Stop' : '▶▶ Play all basic'}
          </button>
        );
      })()}
      {(() => {
        const canUndo = myTurn && (G.undoStack?.length ?? 0) > 0;
        // Undo is a hotseat-only affordance: redactState() zeroes G.undoStack
        // for every viewer online, so canUndo is permanently false there. The
        // button was therefore greyed out with the hidden-card explanation,
        // which is the WRONG reason online and reads as undo being broken
        // (in-game report #75, "undo doesnt work in multiplayer"). Say which
        // of the two it actually is.
        const undoTitle = canUndo
          ? 'Undo your last action. You can keep undoing back to the start of your turn — but not past anything that revealed a hidden card (a draw or a market buy).'
          : isOnline
            ? 'Undo is not available in online games — every move is confirmed by the server as it happens, so there is nothing local to rewind. It works in solo and hotseat games.'
            : 'Nothing to undo. Actions that reveal a hidden card (drawing, buying from the market) cannot be undone.';
        return (
          <button
            onClick={() => { setBaseAction(null); moves.undo(); }}
            disabled={!canUndo}
            title={undoTitle}
            style={{ padding: '8px 16px', background: canUndo ? '#553a20' : '#2a2a2a', color: canUndo ? 'white' : '#777', border: 'none', borderRadius: 4, cursor: canUndo ? 'pointer' : 'not-allowed', marginLeft: 'auto' }}>
            ↶ Undo{canUndo ? ` (${G.undoStack.length})` : ''}
          </button>
        );
      })()}
      <button onClick={handleEndTurn} disabled={!myTurn}
        style={{ padding: '8px 16px', background: '#3a2055', color: 'white', border: 'none', borderRadius: 4, cursor: myTurn ? 'pointer' : 'not-allowed' }}>
        End Turn
      </button>
    </div>
  );

  // A "Deck: 12"-style count that's clickable to open the pile inspector
  // (#68). Rendered as an inline button styled to read like the surrounding
  // status text, so the stat line still looks like a stat line.
  const pileButton = (label: string, count: number, onClick: () => void) => (
    <button onClick={onClick}
      title={`View the cards in your ${label.toLowerCase()}`}
      style={{
        background: 'none', border: 'none', padding: 0, font: 'inherit',
        color: '#a9c6ff', cursor: 'pointer', textDecoration: 'underline',
        textUnderlineOffset: 2,
      }}>
      {label}: {count}
    </button>
  );

  // Pile inspector overlay (#68). Lists the cards in one of the player's own
  // piles. The deck is shown UNORDERED — sorted by deck+slot — so a player
  // can plan around what's left without learning their draw order; discard
  // and inner circle are shown the same way (their order carries no hidden
  // information). Rendered once at the top level so it overlays from any tab.
  const pileViewOverlay = (() => {
    if (!pileView) return null;
    // Resolve which player's pile we're showing (defaults to the local viewer).
    const pp = G.players[pilePlayer ?? me] ?? p;
    const isMe = (pilePlayer ?? me) === me;
    const who = isMe ? 'Your' : `P${Number(pilePlayer) + 1} (${pp.color})'s`;
    // The trophy hall holds captured enemy troop FIGURES, not cards — show it
    // as a per-colour tally (#72) rather than the card grid the other piles use.
    if (pileView === 'trophy') {
      const entries = (Object.entries(pp.trophyHall) as [string, number][])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const total = entries.reduce((s, [, n]) => s + n, 0);
      return (
        <div
          onClick={() => setPileView(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            width: '100vw', height: '100dvh', background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#1a1030', border: '1px solid #3a2055', borderRadius: 8,
              padding: 20, minWidth: 280, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto',
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>
                {who} Trophy Hall <span style={{ opacity: 0.6, fontWeight: 'normal', fontSize: 15 }}>· {total} troop{total === 1 ? '' : 's'}</span>
              </h2>
              <button onClick={() => setPileView(null)}
                style={{ padding: '4px 12px', background: '#3a2055', color: '#e6e1f2', border: '1px solid #5a3380', borderRadius: 4, cursor: 'pointer' }}>
                Close
              </button>
            </div>
            <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.6 }}>
              {isMe
                ? "Enemy (and white) troops you've removed from the board, kept by colour."
                : 'Troops this player has removed from the board, kept by colour.'}
            </div>
            {entries.length === 0 ? (
              <div style={{ opacity: 0.6, padding: '24px 8px' }}>No trophies captured yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {entries.map(([color, n]) => (
                  <div key={color} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 15 }}>
                    <span style={{
                      width: 16, height: 16, borderRadius: '50%', background: color,
                      border: '1px solid rgba(255,255,255,0.4)', display: 'inline-block', flexShrink: 0,
                    }} />
                    <span style={{ textTransform: 'capitalize', minWidth: 70 }}>{color}</span>
                    <span style={{ opacity: 0.85 }}>× {n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    const cards = pileView === 'deck' ? pp.deck
      : pileView === 'discard' ? pp.discard
      : pileView === 'played' ? pp.cardsPlayed
      : pp.innerCircle;
    const title = pileView === 'deck' ? `${who} Deck`
      : pileView === 'discard' ? `${who} Discard Pile`
      : pileView === 'played' ? `${who} Cards Played This Turn`
      : `${who} Inner Circle`;
    const displayCards = pileView === 'played' 
      ? cards 
      : [...cards].sort((a, b) => a.deck.localeCompare(b.deck) || a.slot - b.slot || a.name.localeCompare(b.name));
    return (
      <div
        onClick={() => setPileView(null)}
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          width: '100vw', height: '100dvh', background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: 20,
        }}>
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: '#1a1030', border: '1px solid #3a2055', borderRadius: 8,
            padding: 20, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto',
            boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
          }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>
              {title} <span style={{ opacity: 0.6, fontWeight: 'normal', fontSize: 15 }}>· {cards.length} card{cards.length === 1 ? '' : 's'}</span>
            </h2>
            <button onClick={() => setPileView(null)}
              style={{ padding: '4px 12px', background: '#3a2055', color: '#e6e1f2', border: '1px solid #5a3380', borderRadius: 4, cursor: 'pointer' }}>
              Close
            </button>
          </div>
          {pileView === 'deck' && (
            <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.6 }}>
              Shown in sorted order, not draw order — so this isn't a peek at what you'll draw next.
            </div>
          )}
          {cards.length === 0 ? (
            <div style={{ opacity: 0.6, padding: '24px 8px' }}>This pile is empty.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center' }}>
              {displayCards.map((c, i) => <Card key={i} card={c} />)}
            </div>
          )}
        </div>
      </div>
    );
  })();

  // End-of-game scoreboard.
  if (ctx.gameover && !reviewingBoard) {
    const scores = scoreAll(G);
    const ranked = Object.entries(scores).sort((a, b) => b[1].total - a[1].total);
    const winner = ranked[0];
    return (
      <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ margin: 0 }}>Game Over</h1>
        <button onClick={() => setReviewingBoard(true)}
          title="Go back to the finished board — the map, the log and every pile, exactly as the game ended."
          style={{ marginTop: 10, padding: '8px 16px', background: '#3a2055', color: '#e6e1f2',
            border: '1px solid #5a3380', borderRadius: 4, cursor: 'pointer' }}>
          View the final board →
        </button>
        <div style={{ marginTop: 8, fontSize: 18 }}>
          Winner: <b>P{Number(winner[0]) + 1} ({G.players[winner[0]].color})</b> — {winner[1].total} VP
        </div>
        <table style={{ marginTop: 24, width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #3a2055', textAlign: 'left' }}>
              <th style={{ padding: 4 }}>Player</th>
              <th>Sites</th>
              <th>Total ctrl</th>
              <th>Trophies</th>
              <th>Deck VP</th>
              <th>Inner VP</th>
              <th>VP tokens</th>
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(([pid, s]) => {
              const sitesTip = s.sitesDetail.length === 0
                ? 'You control no sites.'
                : s.sitesDetail.map(d => `${d.site}: +${d.vp}`).join('\n') + `\n— total: +${s.sites}`;
              const totalCtrlTip = s.totalControlDetail.length === 0
                ? 'You have total control of no sites.'
                : s.totalControlDetail.map(d => `${d.site}: +2`).join('\n') + `\n— total: +${s.totalControl}`;
              const trophiesTip = Object.entries(s.trophiesDetail)
                .filter(([, n]) => n > 0)
                .map(([c, n]) => `${c}: ${n}`)
                .join('\n') + `\n— total: ${s.trophies}`;
              const deckTip = s.deckVpDetail.length === 0
                ? 'No deck-VP cards.'
                : s.deckVpDetail.map(d => `${d.card} ×${d.count} @ ${d.vpEach}: +${d.vp}`).join('\n') + `\n— total: +${s.deckVp}`;
              const innerTip = s.innerCircleVpDetail.length === 0
                ? 'No Inner Circle cards.'
                : s.innerCircleVpDetail.map(d => `${d.card} ×${d.count} @ ${d.vpEach}: +${d.vp}`).join('\n') + `\n— total: +${s.innerCircleVp}`;
              const tokensTip = `Mid-game VP tokens earned (site control, deploy-on-empty-barracks, card effects): ${s.vpTokens}`;
              const cell = (val: number | string, tip: string) => (
                <td title={tip} style={{ cursor: 'help' }}>{val}</td>
              );
              const COLOR_HEX: Record<string, string> = { black: '#1a1a1a', red: '#c43c3c', orange: '#e08a2e', blue: '#3473b8', white: '#d0d0d0' };
              const trophiesCell = (
                <td title={trophiesTip} style={{ cursor: 'help' }}>
                  <div>{s.trophies}</div>
                  <div style={{ display: 'flex', gap: 2, marginTop: 2, flexWrap: 'wrap' }}>
                    {Object.entries(s.trophiesDetail)
                      .filter(([, n]) => n > 0)
                      .map(([c, n]) => (
                        <span key={c} title={`${c}: ${n}`}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 2,
                            fontSize: 10, padding: '0 4px', borderRadius: 8,
                            background: 'rgba(255,255,255,0.06)',
                          }}>
                          <span style={{
                            width: 8, height: 8, borderRadius: '50%',
                            // Flat gradient so Samsung/Chrome forced dark mode
                            // leaves this colour-coded trophy dot as authored.
                            background: `linear-gradient(${COLOR_HEX[c] ?? '#888'}, ${COLOR_HEX[c] ?? '#888'})`,
                            border: c === 'black' ? '1px solid #555' : 'none',
                          }} />
                          {n}
                        </span>
                      ))}
                  </div>
                </td>
              );
              return (
                <tr key={pid} style={{ borderBottom: '1px solid #1a1228' }}>
                  <td style={{ padding: 4 }}>P{Number(pid) + 1} ({G.players[pid].color})</td>
                  {cell(s.sites, sitesTip)}
                  {cell(s.totalControl, totalCtrlTip)}
                  {trophiesCell}
                  {cell(s.deckVp, deckTip)}
                  {cell(s.innerCircleVp, innerTip)}
                  {cell(s.vpTokens, tokensTip)}
                  <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{s.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ marginTop: 16, opacity: 0.6, fontSize: 12 }}>
          {isOnline ? (
            <span>
              Game over. <a href="/lobby" style={{ color: '#6cf', opacity: 1 }}>← Back to the lobby</a> to start a new game.
            </span>
          ) : (
            'Reload the page to start a fresh game.'
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: '0 auto' }}>
      {pendingAiSummary && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          width: '100vw', height: '100dvh', background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            background: '#1a1228', color: '#e6e1f2',
            border: '2px solid #3a2055', borderRadius: 6,
            padding: 24, maxWidth: 560, minWidth: 320,
            boxShadow: '0 4px 20px rgba(0,0,0,0.8)',
          }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>
              P{Number(pendingAiSummary.playerId) + 1} ({pendingAiSummary.color}) — turn {pendingAiSummary.turn}
            </h2>
            <div style={{ marginTop: 12, maxHeight: '50vh', overflowY: 'auto', fontSize: 13 }}>
              {pendingAiSummary.lines.length === 0
                ? <div style={{ opacity: 0.6 }}>(no actions)</div>
                : pendingAiSummary.lines.map((l, i) => (
                  <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid #2a1840' }}><CardLogText line={l} /></div>
                ))}
            </div>
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button onClick={() => setShownTurnLogCount(pendingAiSummaryIdx + 1)}
                style={{ padding: '6px 16px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      {/* flexWrap (not display:'auto', which is invalid CSS and silently drops
          the flex layout): keeps the desktop single-row header, lets the
          buttons wrap below the title on narrow mobile viewports. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0, flex: 1 }}>Tyrants of the Underdark</h1>
        <button onClick={() => {
          // Flip in React state — NO page reload (reload triggered the
          // resume-from-save path that could reset the game; see noImages state).
          // localStorage persists the choice; isNoImagesMode() reads it on next load.
          setNoImages(prev => {
            const next = !prev;
            try { localStorage.setItem(NO_IMAGES_KEY, next ? '1' : '0'); } catch { /* ignore */ }
            return next;
          });
        }}
          title="Toggle no-images mode (uses text-only placeholder cards). Persists across reloads."
          style={{ padding: '6px 14px', background: noImages ? '#5a3380' : 'transparent', color: '#e6e1f2', border: '1px solid #3a2055', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          {noImages ? '🖼 images off' : '🖼 images on'}
        </button>
        <button onClick={() => {
          // Toggle in React state (no page reload — reload would dump the
          // user out of mid-game setup). localStorage persists the choice
          // across sessions; isSplitViewMode() reads it on next load.
          setSplitView(prev => {
            const next = !prev;
            try { localStorage.setItem(SPLIT_VIEW_KEY, next ? '1' : '0'); } catch { /* ignore */ }
            return next;
          });
        }}
          title="Toggle split-view mode. Adds a 'play' tab that shows the map and your hand+market on the same page, with hover-to-expand. The original game/map tabs stay available."
          style={{ padding: '6px 14px', background: splitView ? '#5a3380' : 'transparent', color: '#e6e1f2', border: '1px solid #3a2055', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          {splitView ? '📐 split view on' : '📐 split view off'}
        </button>
        <button onClick={() => {
          setSkipSummaries(prev => {
            const next = !prev;
            try { localStorage.setItem(SKIP_SUMMARIES_KEY, next ? '1' : '0'); } catch { /* ignore */ }
            return next;
          });
        }}
          title="Skip the between-turns summary popup. Nothing is lost — every line is still in the Log tab, turn by turn. Leave it on in online games if you want to see what your opponent did."
          style={{ padding: '6px 14px', background: skipSummaries ? '#5a3380' : 'transparent', color: '#e6e1f2', border: '1px solid #3a2055', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          {skipSummaries ? '⏭ turn popups off' : '⏭ turn popups on'}
        </button>
        {/* Log upload targets the worker /game-log relay, which does not exist on
            the online (Cloudflare Pages) deploy — so it always fails online. Online
            games are already captured server-side (framework Supabase snapshots),
            making this feature redundant online. Gate the button + its
            failed/ok indicator off when isOnline; hotseat is unchanged. */}
        {!isOnline && (
        <button onClick={async () => {
          // Click 1: count records and open the disclosure dialog. Actual
          // upload only fires after the user confirms in the dialog (see
          // onConfirm below). The relay dedups by content, so the user can
          // re-click later without producing duplicate commits server-side.
          if (bulkUpload.kind === 'uploading') return;
          const archived = await getAllArchivedGames().catch(() => []);
          // Count only records not already uploaded (+1 for the live game).
          const up = loadUploadedLogIds();
          const pending = archived.filter(a => a.id == null || !up.has(a.id)).length;
          setPendingConsent({ recordCount: pending + 1 });
        }}
          disabled={bulkUpload.kind === 'uploading'}
          title="Upload every completed game stored locally plus the current in-progress game to the public log relay. Already-uploaded records dedup server-side."
          style={{
            padding: '6px 14px',
            background: bulkUpload.kind === 'done' && bulkUpload.failed === 0 ? '#2a4830'
              : bulkUpload.kind === 'done' ? '#5a3030'
              : '#3a2055',
            color: '#e6e1f2', border: '1px solid #5a3380', borderRadius: 4,
            cursor: bulkUpload.kind === 'uploading' ? 'default' : 'pointer',
            opacity: bulkUpload.kind === 'uploading' ? 0.8 : 1,
          }}>
          {bulkUpload.kind === 'uploading' ? `Uploading ${bulkUpload.progress}…`
            : bulkUpload.kind === 'done'
              ? (bulkUpload.failed > 0
                  ? `${bulkUpload.failed} failed · ${bulkUpload.uploaded + bulkUpload.deduped} ok`
                  : `${bulkUpload.uploaded} new · ${bulkUpload.deduped} deduped${bulkUpload.skipped > 0 ? ` · ${bulkUpload.skipped} skipped` : ''}`)
              : 'Upload logs'}
        </button>
        )}
        <button onClick={async () => {
          // Capture the page BEFORE the modal mounts, so the screenshot
          // reflects the game state the user was looking at, not the
          // dialog overlay. The capture is best-effort: failures (CORS,
          // missing API, lazy-import fail) just leave screenshot null
          // and the dialog renders without a preview.
          const shot = await capturePageScreenshot();
          setReportScreenshot(shot);
          setReportOpen(true);
        }}
          style={{ padding: '6px 14px', background: '#3a2055', color: '#e6e1f2', border: '1px solid #5a3380', borderRadius: 4, cursor: 'pointer' }}>
          Report a problem
        </button>
        <button onClick={async () => {
          if (!confirm('Start a new game? Current progress will be lost.')) return;
          // Archive the current playthrough before discarding it, so it
          // doesn't get lost between sessions. The bulk Upload-logs button
          // picks it up on the next click.
          if (session) {
            try {
              await archiveGame(G, {
                numPlayers: Object.keys(G.players).length,
                halfDecks: session.config.halfDecks,
                aiStyles: session.config.aiStyles,
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn('[archive-game] new-game archive failed:', err);
            }
          }
          session?.onNewGame();
        }} style={{ padding: '6px 14px', background: '#5a1f1f', color: '#fdd', border: '1px solid #802626', borderRadius: 4, cursor: 'pointer' }}>
          New game
        </button>
      </div>
      {pileViewOverlay}
      {fixNoteQueue.length > 0 && (
        <BugFixResponseDialog
          update={fixNoteQueue[0]}
          onDismiss={dismissCurrentFixNote}
        />
      )}
      <LogUploadConsentDialog
        open={pendingConsent !== null}
        recordCount={pendingConsent?.recordCount ?? 0}
        onCancel={() => setPendingConsent(null)}
        onConfirm={async () => {
          setPendingConsent(null);
          if (bulkUpload.kind === 'uploading') return;
          const archived = await getAllArchivedGames().catch(() => []);
          // Skip archived records already uploaded in a prior run (#62).
          const uploadedIds = loadUploadedLogIds();
          const toUpload = archived.filter(a => a.id == null || !uploadedIds.has(a.id));
          const skipped = archived.length - toUpload.length;
          const total = toUpload.length + 1; // + the live game (always re-published)
          let done = 0, uploaded = 0, deduped = 0, failed = 0;
          setBulkUpload({ kind: 'uploading', progress: `0 / ${total}` });
          const relayUrl = (import.meta.env.VITE_TOTU_RELAY_URL as string | undefined);
          const submitUrl = relayUrl ? `${relayUrl.replace(/\/$/, '')}/game-log` : '/__publish-game-log';
          for (const a of toUpload) {
            const body = payloadForArchivedGame(a);
            const resp = await fetch(submitUrl, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }).then(r => r.json().catch(() => ({ ok: false }))).catch(() => ({ ok: false }));
            if (resp.ok) {
              (resp.deduped ? deduped++ : uploaded++);
              // Mark uploaded so future runs skip it (server already had it or now does).
              if (a.id != null) markLogUploaded(a.id);
            } else { failed++; }
            done++;
            setBulkUpload({ kind: 'uploading', progress: `${done} / ${total}` });
          }
          const r = await publishGameLog(G, {
            numPlayers: Object.keys(G.players).length,
            halfDecks: session?.config.halfDecks ?? [],
            aiStyles: session?.config.aiStyles ?? [],
            source: 'browser-bulk-upload',
          });
          if (r.ok) { (r.deduped ? deduped++ : uploaded++); } else { failed++; }
          setBulkUpload({ kind: 'done', uploaded, deduped, failed, skipped });
          setTimeout(() => setBulkUpload({ kind: 'idle' }), 6000);
        }}
      />
      {reportOpen && (
        <ProblemReportDialog
          G={G}
          ctxInfo={{ turn: ctx.turn, currentPlayer: ctx.currentPlayer, gameover: ctx.gameover }}
          config={session?.config ? {
            numPlayers: session.config.numPlayers,
            halfDecks: session.config.halfDecks,
            aiStyles: session.config.aiStyles,
          } : undefined}
          screenshotBase64={reportScreenshot}
          onlineSubmit={isOnline ? reportProblem : undefined}
          onClose={() => { setReportOpen(false); setReportScreenshot(null); }}
        />
      )}
      {/* Online seam: surface a rejected-submit / fetch error INSIDE the board
          chrome (integration-guide: "surface errors inside whatever view has
          focus"). Hotseat never sets onlineError, so this never renders there. */}
      {isOnline && onlineError && (
        <div style={{
          marginTop: 8, padding: '8px 12px', borderRadius: 4,
          background: '#5a1f1f', color: '#fdd', border: '1px solid #802626',
          fontSize: 13,
        }}>
          ⚠ {onlineError.message}
        </div>
      )}
      {isOnline && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <a href="/lobby" style={{ color: '#6cf' }}>← Lobby</a>
          <span style={{ opacity: 0.6 }}> · You are seat P{Number(me) + 1} ({p.color})
            {myTurn ? ' — your move' : ctx.gameover ? ' — game over' : ' — waiting for the active player…'}</span>
        </div>
      )}
      <div style={{ marginTop: 8, opacity: 0.7 }}>
        Player P{Number(me) + 1} ({p.color}) — Turn: P{Number(ctx.currentPlayer) + 1} {myTurn ? '(your turn)' : ''}
        {' · '}Power: {p.power} · Influence: {p.influence}
        {' · '}{pileButton('Deck', p.deck.length, () => { setPilePlayer(null); setPileView('deck'); })}
        {' · '}{pileButton('Discard', p.discard.length, () => { setPilePlayer(null); setPileView('discard'); })}
        {' · '}{pileButton('Inner Circle', p.innerCircle.length, () => { setPilePlayer(null); setPileView('inner'); })}
        {' · '}{pileButton('Trophies', Object.values(p.trophyHall).reduce((s, n) => s + n, 0), () => { setPilePlayer(null); setPileView('trophy'); })}
        {' · '}Barracks: {p.barracksLeft} · Spies: {p.spiesLeft}
        {' · '}<b style={{ color: '#ffcc44' }}>VP: {p.vp}</b>
        {G.endGameTriggeredAtTurn !== null && <span style={{ color: '#ffcc44', marginLeft: 8 }}>· Final round!</span>}
      </div>
      <div style={{ marginTop: 6, fontSize: 12 }}>
        {(() => {
          // One line per player so it's easy to read at a glance. Barracks are
          // shown because the game ends when any player's barracks hit 0, so the
          // lowest count tells you how close the end is (Drew W., #82). A
          // player's public piles (discard / inner circle / trophies) are
          // clickable to inspect the actual cards.
          const minBarracks = Math.min(...Object.values(G.players).map(pl => pl.barracksLeft));
          const link = (label: string, n: number, pid: string, kind: 'discard' | 'inner' | 'trophy') => (
            <button
              onClick={() => { setPilePlayer(pid); setPileView(kind); }}
              title={`View P${Number(pid) + 1}'s ${label.toLowerCase()}`}
              style={{
                background: 'none', border: 'none', padding: 0, font: 'inherit',
                color: '#9ecbff', cursor: 'pointer', textDecoration: 'underline',
              }}>
              {n} {label}
            </button>
          );
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Scoreboard</div>
              {Object.entries(G.players).map(([pid, pl]) => {
                const isCurrent = pid === ctx.currentPlayer;
                const isViewer = pid === me;
                const markers = Object.values(G.controlMarkers).filter(m => m.holder === pl.color).length;
                const trophies = Object.values(pl.trophyHall).reduce((s, n) => s + n, 0);
                return (
                  <div key={pid} style={{
                    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    padding: '2px 6px', borderRadius: 4,
                    background: isCurrent ? 'rgba(255,204,68,0.10)' : 'transparent',
                  }}>
                    <ColorSwatch color={pl.color} />
                    <span style={{ minWidth: 78, opacity: 0.9 }}>
                      P{Number(pid) + 1}{isViewer ? ' (you)' : ''}
                    </span>
                    <span style={{ color: '#ffcc44' }}>{pl.vp} VP</span>
                    <span style={{ opacity: 0.55 }}>·</span>
                    <span title="Sites you control">{markers} markers</span>
                    <span style={{ opacity: 0.55 }}>·</span>
                    {link('discard', pl.discard.length, pid, 'discard')}
                    <span style={{ opacity: 0.55 }}>·</span>
                    {link('inner-circle', pl.innerCircle.length, pid, 'inner')}
                    <span style={{ opacity: 0.55 }}>·</span>
                    {link('trophies', trophies, pid, 'trophy')}
                    <span style={{ opacity: 0.55 }}>·</span>
                    <span
                      title="Troops left in barracks. The game ends when any player's barracks reach 0."
                      style={{
                        color: pl.barracksLeft === minBarracks ? '#ff9d6c' : undefined,
                        fontWeight: pl.barracksLeft === minBarracks ? 600 : undefined,
                      }}>
                      {pl.barracksLeft} barracks
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {G.setupPhase && (
        <div style={{ marginTop: 12, padding: 12, background: '#3a2055', borderRadius: 4 }}>
          <div style={{ fontWeight: 'bold' }}>
            Setup — P{Number(ctx.currentPlayer) + 1} ({G.players[ctx.currentPlayer].color}) to deploy
            {isAiTurn ? ' (AI thinking…)' : ''}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
            {myTurn
              ? 'Click any glowing starting site on the map.'
              // Online, the other seat is a remote human (no local AI runs when
              // isOnline — the AI driver effect is gated on isAiTurn=!isOnline).
              // Name the waiting target by the active seat's color rather than "AI".
              : isOnline
                ? `Waiting for ${G.players[ctx.currentPlayer].color} (the other player).`
                : 'Waiting on AI.'}
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {(() => {
          // Tab list. In normal mode: game, map, log (+ dev tabs). In split-
          // view mode: 'play' replaces game + map (everything is on one
          // screen, so the separate tabs are redundant and showing them is
          // confusing). Log + dev tabs still available.
          if (splitView) {
            const dev = devMode
              ? ['calibrate', 'routes', 'cards', 'costs', 'text', 'sites', 'whites', 'slots', 'dividers', 'markers'] as const
              : [] as const;
            return ['play', ...dev, 'log'] as readonly string[];
          }
          return devMode
            ? ['game', 'map', 'calibrate', 'routes', 'cards', 'costs', 'text', 'sites', 'whites', 'slots', 'dividers', 'markers', 'log'] as const
            : ['game', 'map', 'log'] as const;
        })().map(t => (
          <button key={t} onClick={() => {
            // Manual tab change implicitly cancels any sticky base action — the
            // user is leaving the map context, so they don't want the deploy /
            // assassinate / return-spy mode to follow them around.
            if (baseAction) setBaseAction(null);
            setTab(t as typeof tab);
          }}
            style={{ padding: '4px 12px', background: tab === t ? '#3a2055' : 'transparent', color: '#e6e1f2', border: '1px solid #3a2055', borderRadius: 4, cursor: 'pointer' }}>
            {t}
            {t === 'play' && G.pendingChoice && G.pendingChoice.playerId === me && (
              <span style={{ marginLeft: 6, display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#e04050', verticalAlign: 'middle' }} />
            )}
          </button>
        ))}
        {devMode && (
          <button onClick={() => { setDevMode(false); if (tab !== 'game' && tab !== 'map' && tab !== 'log') setTab('game'); }}
            title="Hide development tabs (calibrate, routes, cards, costs, text, sites, edges, slots). Re-enable with ?dev=1 in the URL."
            style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11, background: 'transparent', color: '#888', border: '1px solid #444', borderRadius: 3, cursor: 'pointer' }}>
            hide dev tabs
          </button>
        )}
      </div>

      {tab === 'map' && (
        <div style={{ marginTop: 16 }}>
          {humanMapPick && (
            <div style={{ marginBottom: 8, padding: 8, background: '#3a2055', borderRadius: 4 }}>
              <b>{humanMapPick.prompt}</b>
              {humanMapPick.optional && (
                <button onClick={() => moves.resolveChoice(null)} style={{ marginLeft: 12, padding: '2px 8px', fontSize: 12 }}>
                  Decline
                </button>
              )}
              {(humanMapPick.highlight?.length ?? 0) > 0 && (
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                  Green rings mark the sites where this card’s follow-up has a target.
                </div>
              )}
            </div>
          )}
          {/* choose-one / select-player prompts surfaced here too — without
              this the user has to flip back to the game tab to resolve each
              iteration of cards like Intellect Devourer that loop chooseOne
              under times(). */}
          {spyPickBar}{interactivePromptBar}
          {/* Action bar rendered ABOVE the map so it's reachable without
              scrolling past the (large) board image. Per user feedback —
              this is the bar most likely needed while looking at the map
              (Cancel sticky base-actions, Assassinate / Deploy / Return
              Spy / End Turn). Kept inside the map-tab block so the bar
              only shows when relevant. */}
          {reviewBanner}{actionBar}
          <MapView G={G}
            clickableSites={startingClickable} onSiteClick={handleSiteClick}
            highlightSites={highlightSites}
            clickableSpaces={clickableSpaces} onSpaceClick={handleSpaceClick} />
        </div>
      )}
      {tab === 'play' && (
        <SplitPlayView
          G={G} ctx={ctx} myTurn={myTurn} p={p} moves={moves}
          playCardSafe={playCardSafe}
          startingClickable={startingClickable} handleSiteClick={handleSiteClick}
          highlightSites={highlightSites}
          clickableSpaces={clickableSpaces} handleSpaceClick={handleSpaceClick}
          clickableMarketSlots={clickableMarketSlots}
          humanMapPick={humanMapPick}
          actionBar={<>{reviewBanner}{actionBar}</>}
          interactivePromptBar={<>{spyPickBar}{interactivePromptBar}</>}
          mySeat={me}
          onViewPile={setPileView}
        />
      )}
      {tab === 'calibrate' && <div style={{ marginTop: 16 }}><MapView calibrate /></div>}
      {tab === 'routes' && <div style={{ marginTop: 16 }}><MapView editRoutes /></div>}
      {tab === 'cards' && <div style={{ marginTop: 16 }}><CardCalibration /></div>}
      {tab === 'costs' && <div style={{ marginTop: 16 }}><CostVerify /></div>}
      {tab === 'text' && <div style={{ marginTop: 16 }}><CardTextVerify /></div>}
      {tab === 'sites' && <div style={{ marginTop: 16 }}><SiteVerify /></div>}
      {tab === 'whites' && <div style={{ marginTop: 16 }}><RouteVerify /></div>}
      {tab === 'slots' && <div style={{ marginTop: 16 }}><SlotCalibration /></div>}
      {tab === 'dividers' && <div style={{ marginTop: 16 }}><SectionDividerCalibration /></div>}
      {tab === 'markers' && <div style={{ marginTop: 16 }}><MarkerCalibration /></div>}
      {tab === 'log' && (
        <div style={{ marginTop: 16 }}>
          {spyPickBar}{interactivePromptBar}
          <GameLog G={G} onLoad={(codec) => moves.loadState(codec)} />
        </div>
      )}

      {tab === 'game' && <>
        {/* Online: a pending choice that is NOT the local seat's belongs to the
            opponent. Its options/prompt were redacted by viewFor, so render only
            a quiet "opponent is choosing…" indicator — never the dialog/controls.
            Hotseat (isOnline=false) is unchanged: the human sees every pending
            choice, including an AI's, exactly as before. */}
        {isOnline && G.pendingChoice && G.pendingChoice.playerId !== me && (
          <div style={{ marginTop: 16, padding: 12, background: '#2a1840', borderRadius: 4, opacity: 0.8, fontStyle: 'italic' }}>
            Opponent is choosing…
          </div>
        )}
        {G.pendingChoice && (!isOnline || G.pendingChoice.playerId === me) && (
          <div style={{ marginTop: 16, padding: 12, background: '#3a2055', borderRadius: 4 }}>
            <div style={{ fontWeight: 'bold' }}>{G.pendingChoice.prompt}</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
              For P{Number(G.pendingChoice.playerId) + 1}.
              {/* Not always a discard — the same prompt kind covers Focus
                  reveals (card stays in hand) and devour-from-hand. The
                  prompt text above already says which; keep the hint neutral
                  so it can't contradict it. */}
              {G.pendingChoice.kind === 'select-card-in-hand' && ' Click a card in your hand.'}
              {G.pendingChoice.kind === 'select-site' && ' Click a glowing site on the map.'}
              {/* #105: for place-a-spy prompts whose card acts at that same
                  site afterwards, say which rings are the ones that pay off. */}
              {G.pendingChoice.kind === 'select-site'
                && (G.pendingChoice.highlight?.length ?? 0) > 0
                && ' The green rings are where this card’s follow-up has a target.'}
              {G.pendingChoice.kind === 'select-troop-space' && ' Click a glowing troop space on the map.'}
            </div>
            {G.pendingChoice.kind === 'choose-one' && G.pendingChoice.playerId === me && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {((G.pendingChoice.options as string[] | undefined) ?? []).map((label, i) => (
                  <button key={i} onClick={() => moves.resolveChoice(i)} style={{ padding: '6px 12px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {G.pendingChoice.kind === 'select-player' && G.pendingChoice.playerId === me && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {((G.pendingChoice.options as string[] | undefined) ?? []).map(pid => (
                  <button key={pid} onClick={() => moves.resolveChoice(pid)}
                    style={{ padding: '6px 12px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                    {playerColorLabel(G.players[pid].color, pid)}
                  </button>
                ))}
              </div>
            )}
            {G.pendingChoice.optional && (
              <button onClick={() => moves.resolveChoice(null)} style={{ marginTop: 8, padding: '4px 12px' }}>
                Decline
              </button>
            )}
          </div>
        )}

        {/* Online-only "whose turn" banner in the empty space above the market.
            Gated on isOnline && currentActor !== me, so hotseat (isOnline=false)
            renders nothing here and is visually unchanged. */}
        {showOpponentTurnBanner && opponentTurnLabel && (
          <>
            <style>{`
              @keyframes tot-opponent-turn-pulse {
                0%, 100% { opacity: 0.55; transform: scale(1); }
                50%      { opacity: 1;    transform: scale(1.025); }
              }
            `}</style>
            <div style={{
              marginTop: 24, marginBottom: 8, padding: '18px 24px',
              textAlign: 'center', fontSize: 26, fontWeight: 700,
              letterSpacing: 0.5, color: '#f0e8ff',
              animation: 'tot-opponent-turn-pulse 2.2s ease-in-out infinite',
            }}>
              {opponentTurnLabel}
            </div>
          </>
        )}

        {reviewBanner}{actionBar}

        {G.pendingChoice?.kind === 'select-card-in-discard' && G.pendingChoice.playerId === me && (
          <>
            <h2 style={{ marginTop: 24 }}>Discard — pick one</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center' }}>
              {/* Only the engine-supplied option indices are valid — e.g. Matron
                  Mother excludes cards played this turn (those are in your play
                  area, not your discard pile). Show only those. */}
              {(() => {
                const opts = G.pendingChoice!.options as number[] | undefined;
                const idxs = opts ?? p.discard.map((_, i) => i);
                return idxs
                  .filter(i => p.discard[i])
                  .map(i => (
                    <Card key={i} card={p.discard[i]} label="pick" onClick={() => moves.resolveChoice(i)} />
                  ));
              })()}
            </div>
          </>
        )}

        {G.pendingChoice?.kind === 'select-card-in-inner-circle' && G.pendingChoice.playerId === me && (
          <>
            <h2 style={{ marginTop: 24 }}>Inner Circle — pick one to devour</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center' }}>
              {p.innerCircle.map((c, i) => (
                <Card key={i} card={c} label="devour" onClick={() => moves.resolveChoice(i)} />
              ))}
            </div>
          </>
        )}

        {G.pendingChoice?.kind === 'select-played-card' && G.pendingChoice.playerId === me && (
          <>
            <h2 style={{ marginTop: 24 }}>Played this turn — pick one to promote</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center' }}>
              {/* Show all cards played this turn, dimming ineligible ones (the trigger
                  card itself or aspect-filtered mismatches). The original index is
                  preserved for resolveChoice. */}
              {G.cardsPlayedThisTurn.map((c, i) => {
                const eligibleIdxs = G.pendingChoice!.options as number[] | undefined;
                const eligible = !eligibleIdxs || eligibleIdxs.includes(i);
                return (
                  <Card key={i} card={c} label={eligible ? "promote" : undefined} onClick={eligible ? () => moves.resolveChoice(i) : undefined} dim={!eligible} />
                );
              })}
            </div>
          </>
        )}

        <h2 style={{ marginTop: 24, display: 'flex', alignItems: 'baseline', gap: 12 }}>
          Your Hand
          <button onClick={() => { setPilePlayer(null); setPileView('played'); }}
            title="View cards you played this turn"
            style={{
              background: 'none', border: 'none', padding: 0, font: 'inherit',
              color: '#a9c6ff', cursor: 'pointer', textDecoration: 'underline',
              textUnderlineOffset: 2, fontSize: 14, fontWeight: 'normal'
            }}>
            Played this turn: {p.cardsPlayed.length}
          </button>
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center' }}>
          {p.hand.map((c, i) => {
            // The discard/devour-from-hand prompt is always answered by the
            // prompted player — usually the current player, but for forced
            // discards (Mindwitness, Chuul, Neogi, …) the prompt may target
            // the human while it's an AI's turn. Gate on HUMAN_SEAT, not
            // currentPlayer.
            const isChoosing = G.pendingChoice?.kind === 'select-card-in-hand' && G.pendingChoice.playerId === me;
            // If options provided, only those indices are pickable (e.g. Focus reveal filtered to one aspect).
            const opts = isChoosing ? (G.pendingChoice!.options as number[] | undefined) : undefined;
            const eligible = !isChoosing || !opts || opts.includes(i);
            // Ineligible cards during a choice are shown dimmed (not hidden) but
            // must NOT be clickable — clicking one would submit resolveChoice with
            // an index the engine rejects. Gate onClick + the 'pick' label on
            // eligibility, matching the promote-played-card section above.
            const onClick = isChoosing
              ? (eligible ? () => moves.resolveChoice(i) : undefined)
              : (myTurn && !G.pendingChoice ? () => playCardSafe(i) : undefined);
            const label = isChoosing ? (eligible ? 'pick' : undefined) : 'play';
            return <Card key={i} card={c} label={label} onClick={onClick} dim={isChoosing && !eligible}/>;
          })}
        </div>

        <h2 style={{ marginTop: 24 }}>
          Market <span style={{ fontSize: 13, opacity: 0.7, fontWeight: 'normal' }}>· {G.market.deck.length} cards left in deck</span>
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center' }}>
          {/* Rotating market row (6 slots from the chosen half-decks). */}
          {G.market.row.map((c, i) => {
            if (!c) return <div key={i} style={{ width: 120, height: 168, margin: 4, border: '1px dashed #444', borderRadius: 8 }} />;
            const inPickMode = !!clickableMarketSlots;
            const slotPickable = inPickMode && clickableMarketSlots!.has(i);
            const cost = lookupCard(c.deck, c.slot)?.cost ?? '?';
            // A prompt that isn't a market pick (a Focus reveal, an end-of-turn
            // promote, a forced discard…) still blocks recruiting: the move
            // bounces as INVALID_MOVE and nothing happens. The hand and the
            // aux stacks already gate on !pendingChoice; the rotating row was
            // the one place left where "recruit" looked live but wasn't, which
            // reads as the click having triggered the prompt.
            const blocked = !inPickMode && !!G.pendingChoice;
            const label = inPickMode
              ? (slotPickable ? 'pick' : '—')
              : blocked ? '—' : `recruit (${cost} Inf)`;
            const onClick = inPickMode
              ? (slotPickable ? () => moves.resolveChoice(i) : undefined)
              : (myTurn && !blocked ? () => moves.recruitFromMarket(i) : undefined);
            return <Card key={i} card={c} label={label} onClick={onClick} dim={(inPickMode && !slotPickable) || blocked} />;
          })}
          {/* Permanent stacks (House Guards, Priestesses of Lolth) — always
              recruitable while non-empty; once empty, greyed out and the
              button is disabled. Recruiting these doesn't trigger end-of-
              game (only the rotating deck emptying does). */}
          {(['houseGuards', 'priestesses'] as const).map(stack => {
            const ref = stack === 'houseGuards'
              ? { deck: 'house-guards', slot: 40 }
              : { deck: 'priestesses',  slot: 43 };
            const data = lookupCard(ref.deck, ref.slot);
            if (!data) return null;
            const card: CardRef = { deck: ref.deck, slot: ref.slot, name: data.name, image: data.image };
            const remaining = G.auxStacks?.[stack] ?? 0;
            const cost = data.cost ?? 999;
            // Sentinel picks from a free-recruit prompt (e.g. Conjurer):
            //  -1 = House Guard, -2 = Priestess.  When the picker offers
            //  these, clicking the aux-stack card resolves the choice.
            const sentinel = stack === 'houseGuards' ? -1 : -2;
            const freeRecruitPickable = !!clickableMarketSlots && clickableMarketSlots.has(sentinel);
            const canRecruit = myTurn && remaining > 0 && p.influence >= cost && !G.pendingChoice;
            const label = remaining === 0
              ? `empty · ${data.name}`
              : freeRecruitPickable
                ? `pick (free) · ${remaining} left`
                : `recruit (${cost} Inf) · ${remaining} left`;
            const onClick = freeRecruitPickable
              ? () => moves.resolveChoice(sentinel)
              : canRecruit
                ? () => moves.recruitFromAuxStack(stack)
                : undefined;
            return (
              <div key={stack} style={{ opacity: remaining === 0 ? 0.4 : 1 }}>
                <Card card={card} label={label} onClick={onClick} dim={!!clickableMarketSlots && !freeRecruitPickable} />
              </div>
            );
          })}
        </div>

        <GameTabLog log={G.log} />
      </>}
    </div>
  );
}

/** Best-effort "N games played" counter from the games hub. Renders nothing
 *  until/unless the count loads; never blocks or errors the dialog. */
function GamesPlayedCount() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetch('https://games-hub-5vo.pages.dev/stats?game=tyrants')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (live && d && typeof d.count === 'number') setCount(d.count); })
      .catch(() => { /* best-effort: hub down / offline — show nothing */ });
    return () => { live = false; };
  }, []);
  if (count === null || count <= 0) return null;
  return (
    <div style={{ marginTop: -8, marginBottom: 16, fontSize: 12, opacity: 0.55 }}>
      {count.toLocaleString()} game{count === 1 ? '' : 's'} played
    </div>
  );
}

function NewGameDialog({ onStart, hasSave, onResume, lastConfig }: {
  onStart: (cfg: GameConfig) => void;
  hasSave: boolean;
  onResume: () => void;
  lastConfig: GameConfig | null;
}) {
  // Defaults seeded from the most recent stored config so reopening the dialog
  // remembers the prior numPlayers / AI styles / half-deck pick.
  const [numPlayers, setNumPlayers] = useState(lastConfig?.numPlayers ?? 4);
  const [styles, setStyles] = useState<AiStyle[]>(
    lastConfig?.aiStyles?.length ? lastConfig.aiStyles : ['heuristic', 'heuristic', 'heuristic']
  );
  const [halfDecks, setHalfDecks] = useState<HalfDeck[]>(
    lastConfig?.halfDecks?.length === 2 ? lastConfig.halfDecks : ['drow', 'dragons']
  );
  const [thirdSide, setThirdSide] = useState<ThirdPlayerSide>(
    lastConfig?.thirdPlayerSide ?? 'left'
  );
  const [humanColor, setHumanColor] = useState<Color>(
    lastConfig?.humanColor ?? COLORS[0]
  );

  function setStyle(i: number, s: AiStyle) {
    setStyles(prev => {
      const next = prev.slice();
      next[i] = s;
      return next;
    });
  }

  function toggleDeck(d: HalfDeck) {
    setHalfDecks(prev => {
      if (prev.includes(d)) return prev.filter(x => x !== d);
      if (prev.length >= 2) return [prev[1], d]; // bump oldest, keep last 2
      return [...prev, d];
    });
  }

  function randomizeDecks() {
    const pool = [...HALF_DECKS].sort(() => Math.random() - 0.5);
    setHalfDecks([pool[0], pool[1]]);
  }

  const opponentCount = numPlayers - 1;
  const trimmedStyles = styles.slice(0, opponentCount);
  while (trimmedStyles.length < opponentCount) trimmedStyles.push('heuristic');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 12px' }}>
      <div style={{ background: '#1a1228', color: '#e6e1f2', border: '2px solid #3a2055', borderRadius: 8, padding: 32, width: '100%', minWidth: 'min(420px, 100%)', maxWidth: 560, boxSizing: 'border-box' }}>
        <h1 style={{ marginTop: 0, marginBottom: 8 }}>Tyrants of the Underdark</h1>
        <GamesPlayedCount />
        {hasSave && (
          <div style={{ marginBottom: 24, padding: 12, background: '#2a1840', borderRadius: 4 }}>
            <div style={{ marginBottom: 8 }}>A game in progress was found.</div>
            <button onClick={onResume} style={{ padding: '8px 16px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
              Resume saved game
            </button>
          </div>
        )}
        <h3>New game</h3>
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
            <label style={{ opacity: 0.85 }}>Number of players</label>
            <a href="/lobby"
              title="Set up an online game you can play with a friend over separate devices"
              style={{ fontSize: 13, color: '#b69cff', textDecoration: 'none' }}>
              Multiplayer →
            </a>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[2, 3, 4].map(n => (
              <button key={n} onClick={() => setNumPlayers(n)}
                style={{
                  padding: '6px 16px', cursor: 'pointer', borderRadius: 4,
                  background: numPlayers === n ? '#5a3380' : '#2a1840',
                  color: '#e6e1f2', border: '1px solid #3a2055',
                }}>{n}</button>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.65 }}>
            {numPlayers === 2 && 'Center section only.'}
            {numPlayers === 3 && 'Center + one outer section.'}
            {numPlayers === 4 && 'All three sections.'}
          </div>
        </div>
        {numPlayers === 3 && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, opacity: 0.85 }}>Which outer section?</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['left', 'right'] as ThirdPlayerSide[]).map(side => (
                <button key={side} onClick={() => setThirdSide(side)}
                  style={{
                    padding: '6px 16px', cursor: 'pointer', borderRadius: 4,
                    background: thirdSide === side ? '#5a3380' : '#2a1840',
                    color: '#e6e1f2', border: '1px solid #3a2055',
                  }}>{side}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', marginBottom: 4, opacity: 0.85 }}>Opponents (P1 is you)</label>
          {Array.from({ length: opponentCount }, (_, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 32, opacity: 0.7 }}>P{i + 2}</span>
              {(['random', 'easy', 'heuristic'] as AiStyle[]).map(s => (
                <button key={s} onClick={() => setStyle(i, s)}
                  title={
                    s === 'random' ? 'Picks a legal move at random. Almost never wins.'
                    : s === 'easy' ? 'Heuristic AI without lookahead. Plays sensible moves but doesn\'t see the consequences of choices. Beats humans ~8% in our data.'
                    : 'Heuristic AI with full lookahead (looks ahead to end-of-turn state, picks targets that pay off). Beats humans ~32% in our data.'
                  }
                  style={{
                    padding: '4px 12px', cursor: 'pointer', borderRadius: 4, fontSize: 12,
                    background: trimmedStyles[i] === s ? '#5a3380' : '#2a1840',
                    color: '#e6e1f2', border: '1px solid #3a2055',
                  }}>{s === 'heuristic' ? 'standard' : s}</button>
              ))}
            </div>
          ))}
        </div>
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', marginBottom: 4, opacity: 0.85 }}>Your colour</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SELECTABLE_COLORS.map(c => {
              const on = humanColor === c;
              return (
                <button key={c} onClick={() => setHumanColor(c)}
                  style={{
                    display: 'flex', alignItems: 'center',
                    padding: '6px 12px', cursor: 'pointer', borderRadius: 4, fontSize: 12,
                    background: on ? '#5a3380' : '#2a1840',
                    color: '#e6e1f2', border: on ? '1px solid #b69cff' : '1px solid #3a2055',
                    textTransform: 'capitalize',
                  }}>
                  <ColorSwatch color={c} />{c}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.55 }}>
            Opponents take the classic colours (black, red, orange, blue).
          </div>
        </div>
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', marginBottom: 4, opacity: 0.85 }}>
            Market half-decks (pick 2) <span style={{ opacity: 0.5, fontSize: 11 }}>· {halfDecks.length}/2 selected</span>
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {HALF_DECKS.filter(d => !EXPANSION_HALF_DECKS.has(d)).map(d => {
              const on = halfDecks.includes(d);
              const idx = halfDecks.indexOf(d);
              return (
                <button key={d} onClick={() => toggleDeck(d)}
                  style={{
                    padding: '6px 12px', cursor: 'pointer', borderRadius: 4,
                    background: on ? '#5a3380' : '#2a1840',
                    color: '#e6e1f2', border: '1px solid #3a2055',
                    fontSize: 12, position: 'relative',
                  }}>
                  {d}{on && <span style={{ marginLeft: 6, opacity: 0.7 }}>#{idx + 1}</span>}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, opacity: 0.55, margin: '8px 0 4px' }}>
            Aberrations &amp; Undead expansion:
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {HALF_DECKS.filter(d => EXPANSION_HALF_DECKS.has(d)).map(d => {
              const on = halfDecks.includes(d);
              const idx = halfDecks.indexOf(d);
              return (
                <button key={d} onClick={() => toggleDeck(d)}
                  title="From the Aberrations &amp; Undead expansion. Card-effect mechanics are still being wired in — selecting these now gives you the card art and basic flow, but some cards' special effects may be no-ops until that's complete."
                  style={{
                    padding: '6px 12px', cursor: 'pointer', borderRadius: 4,
                    background: on ? '#5a3380' : '#2a1840',
                    color: '#e6e1f2', border: '1px dashed #6a4595',
                    fontSize: 12, position: 'relative',
                  }}>
                  {d}{on && <span style={{ marginLeft: 6, opacity: 0.7 }}>#{idx + 1}</span>}
                </button>
              );
            })}
          </div>
          <button onClick={randomizeDecks}
            style={{ padding: '4px 12px', fontSize: 12, background: '#2a1840', color: '#e6e1f2', border: '1px solid #3a2055', borderRadius: 4, cursor: 'pointer' }}>
            Random 2
          </button>
        </div>
        <button
          disabled={halfDecks.length !== 2}
          onClick={() => onStart({ numPlayers, aiStyles: trimmedStyles, halfDecks, thirdPlayerSide: thirdSide, humanColor })}
          style={{
            padding: '10px 24px', fontSize: 14, color: '#fff', border: 'none',
            borderRadius: 4,
            background: halfDecks.length === 2 ? '#5a3380' : '#3a3a3a',
            cursor: halfDecks.length === 2 ? 'pointer' : 'not-allowed',
            opacity: halfDecks.length === 2 ? 1 : 0.5,
          }}>
          Start game
        </button>
      </div>
    </div>
  );
}

function ClientHolder({ config, onNewGame }: { config: GameConfig; onNewGame: () => void }) {
  // Memoize the Client so it isn't re-created on every render — that would discard
  // game state. Re-create only when numPlayers changes.
  // Wrap the game definition so the setup closure carries the chosen half-decks
  // (boardgame.io's React Client doesn't expose setupData directly, so we bind
  // it via a fresh setup function per config). Re-create the Client whenever
  // numPlayers or halfDecks change.
  const ClientCmp = useMemo(() => {
    const origSetup = TyrantsGame.setup!;
    const game = {
      ...TyrantsGame,
      setup: (args: Parameters<typeof origSetup>[0]) =>
        origSetup(args, {
          halfDecks: config.halfDecks,
          activeSections: activeSectionsFor(config),
          humanColor: config.humanColor,
        }),
    };
    return Client({ game, board: Board, numPlayers: config.numPlayers, debug: false });
  }, [config.numPlayers, config.halfDecks, config.humanColor]);
  return (
    <SessionContext.Provider value={{ config, onNewGame }}>
      <ClientCmp />
    </SessionContext.Provider>
  );
}

function loadConfig(): GameConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as Partial<GameConfig>;
    if (cfg && typeof cfg.numPlayers === 'number' && Array.isArray(cfg.aiStyles)) {
      const halfDecks = (Array.isArray(cfg.halfDecks) && cfg.halfDecks.length === 2
        ? cfg.halfDecks
        : ['drow', 'dragons']) as HalfDeck[];
      return {
        numPlayers: cfg.numPlayers, aiStyles: cfg.aiStyles, halfDecks,
        thirdPlayerSide: cfg.thirdPlayerSide,
        humanColor: cfg.humanColor,
      };
    }
  } catch { /* fall through */ }
  return null;
}

/** When a saved game exists but no stored config (e.g. save from before the
 *  New-Game-Dialog refactor), reconstruct a usable config by decoding the codec
 *  to count players. AI styles default to all-heuristic — user can still hit
 *  "New game" if they want to reconfigure. */
function configFromSave(codec: string): GameConfig | null {
  try {
    const json = decodeURIComponent(escape(atob(codec.trim())));
    const parsed = JSON.parse(json) as { players?: Record<string, unknown> };
    if (!parsed.players) return null;
    const numPlayers = Object.keys(parsed.players).length;
    if (numPlayers < 2 || numPlayers > 4) return null;
    const aiStyles: AiStyle[] = Array.from({ length: numPlayers - 1 }, () => 'heuristic');
    return { numPlayers, aiStyles, halfDecks: ['drow', 'dragons'] };
  } catch { return null; }
}

/** Split-view layout: map on top, hand + market strip below. Hover (on
 *  hover-capable devices) expands the panel under the cursor and shrinks
 *  the other; on touch devices the panel responds to taps via a focus
 *  state. Per James Roberts' forum feedback — "would it be possible to
 *  somehow have your hand of cards and the market on the same page as
 *  the map." Opt-in via the split-view toggle; the original game/map
 *  tabs stay unchanged as the default. */
function SplitPlayView(props: {
  G: TyrantsState;
  ctx: { currentPlayer: string };
  myTurn: boolean;
  p: TyrantsState['players'][string];
  moves: Record<string, (...args: unknown[]) => void>;
  playCardSafe: (idx: number) => void;
  startingClickable: Set<string> | undefined;
  handleSiteClick: (siteId: string) => void;
  /** Advisory subset of startingClickable whose ring is drawn solid (#105). */
  highlightSites: Set<string> | undefined;
  clickableSpaces: Set<string> | undefined;
  handleSpaceClick: (spaceId: string) => void;
  clickableMarketSlots: Set<number> | null | undefined;
  humanMapPick: { prompt: string; optional?: boolean; highlight?: string[] } | null;
  actionBar: React.ReactNode;
  interactivePromptBar: React.ReactNode;
  /** Seat the local human controls — '0' in hotseat, the server-assigned seat
   *  online. Used to gate which side's pendingChoice prompts render. */
  mySeat: string;
  /** Open the pile inspector overlay for one of the player's own piles (#68). */
  onViewPile: (pile: 'deck' | 'discard' | 'inner' | 'trophy' | 'played') => void;
}) {
  const { G, myTurn, p, moves, playCardSafe,
          startingClickable, handleSiteClick, highlightSites, clickableSpaces, handleSpaceClick,
          clickableMarketSlots, humanMapPick, actionBar, interactivePromptBar,
          mySeat: me, onViewPile } = props;
  const [focus, setFocus] = useState<'map' | 'cards' | null>(null);

  // Hover expansion: on hover-capable devices, mouse enter/leave drive
  // which panel takes more vertical space. On touch, focus is unset and
  // both panels share the space 50/50 (tap a card to play it normally).
  const enterMap = HOVER_CAPABLE ? () => setFocus('map') : undefined;
  const leaveMap = HOVER_CAPABLE ? () => setFocus(prev => prev === 'map' ? null : prev) : undefined;
  const enterCards = HOVER_CAPABLE ? () => setFocus('cards') : undefined;
  const leaveCards = HOVER_CAPABLE ? () => setFocus(prev => prev === 'cards' ? null : prev) : undefined;

  // Flex weights — when one panel is focused it claims most of the height;
  // otherwise the map gets ~60% (typical board games favor seeing the
  // board at all times) and cards get ~40%.
  const mapFlex = focus === 'map' ? '4 1 0' : focus === 'cards' ? '1 1 0' : '3 1 0';
  const cardsFlex = focus === 'cards' ? '4 1 0' : focus === 'map' ? '1 1 0' : '2 1 0';

  const sectionBox = (kind: 'map' | 'cards'): React.CSSProperties => ({
    flex: kind === 'map' ? mapFlex : cardsFlex,
    overflow: 'auto',
    transition: 'flex 280ms ease',
    minHeight: 80,
  });

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, height: 'calc(100vh - 160px)' }}>
      {humanMapPick && (
        <div style={{ padding: 8, background: '#3a2055', borderRadius: 4 }}>
          <b>{humanMapPick.prompt}</b>
          {humanMapPick.optional && (
            <button onClick={() => moves.resolveChoice(null)} style={{ marginLeft: 12, padding: '2px 8px', fontSize: 12 }}>
              Decline
            </button>
          )}
          {(humanMapPick.highlight?.length ?? 0) > 0 && (
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
              Green rings mark the sites where this card’s follow-up has a target.
            </div>
          )}
        </div>
      )}
      {interactivePromptBar}
      {/* Generic prompt banner: when a pendingChoice is set for the current
          player and isn't already shown by interactivePromptBar (choose-one /
          select-player) or the humanMapPick banner above, surface the prompt
          text here. Without this, prompts like "Devour a card from your hand"
          (Wight, Vampire Spawn, etc.) were silently waiting for a hand click
          with no instruction — reported as #37. */}
      {G.pendingChoice && G.pendingChoice.playerId === me
        && G.pendingChoice.kind !== 'choose-one' && G.pendingChoice.kind !== 'select-player'
        && G.pendingChoice.kind !== 'select-site' && G.pendingChoice.kind !== 'select-troop-space'
        && !humanMapPick && (
          <div style={{ padding: 8, background: '#3a2055', borderRadius: 4 }}>
            <b>{G.pendingChoice.prompt}</b>
            {G.pendingChoice.optional && (
              <button onClick={() => moves.resolveChoice(null)} style={{ marginLeft: 12, padding: '2px 8px', fontSize: 12 }}>
                Decline
              </button>
            )}
          </div>
        )}
      {actionBar}
      {/* Pile inspector strip (#68): split view has no full status line, so
          surface clickable Deck / Discard / Inner Circle counts here. */}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', fontSize: 13, flexWrap: 'wrap' }}>
        {([['Deck', p.deck.length, 'deck'], ['Discard', p.discard.length, 'discard'], ['Inner Circle', p.innerCircle.length, 'inner'], ['Trophies', Object.values(p.trophyHall).reduce((s, n) => s + n, 0), 'trophy']] as const).map(([label, count, key]) => (
          <button key={key} onClick={() => onViewPile(key)}
            title={`View the cards in your ${label.toLowerCase()}`}
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: '#a9c6ff', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>
            {label}: {count}
          </button>
        ))}
      </div>
      {/* Card-pile pickers that only render in the game tab by default —
          end-of-turn promote, devour-from-discard, devour-from-inner-circle.
          Without these in split view the user has no way to resolve those
          prompts and the game stalls (reported as issue #34). */}
      {G.pendingChoice?.kind === 'select-played-card' && G.pendingChoice.playerId === me && (
        <div>
          <h3 style={{ margin: '4px 0', fontSize: 14, opacity: 0.85 }}>Played this turn — pick one to promote</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {/* Show all cards played this turn, dimming ineligible ones (the trigger
                card itself or aspect-filtered mismatches); keep original index for resolveChoice. */}
            {G.cardsPlayedThisTurn.map((c, i) => {
              const eligibleIdxs = G.pendingChoice!.options as number[] | undefined;
              const eligible = !eligibleIdxs || eligibleIdxs.includes(i);
              return (
                <Card key={i} card={c} label={eligible ? "promote" : undefined} onClick={eligible ? () => moves.resolveChoice(i) : undefined} dim={!eligible} />
              );
            })}
          </div>
        </div>
      )}
      {G.pendingChoice?.kind === 'select-card-in-discard' && G.pendingChoice.playerId === me && (
        <div>
          <h3 style={{ margin: '4px 0', fontSize: 14, opacity: 0.85 }}>Discard — pick one</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {/* Honor the engine's option list (Matron Mother excludes cards
                played this turn — they're in the play area, not the discard). */}
            {(() => {
              const opts = G.pendingChoice!.options as number[] | undefined;
              const idxs = opts ?? p.discard.map((_, i) => i);
              return idxs
                .filter(i => p.discard[i])
                .map(i => (
                  <Card key={i} card={p.discard[i]} label="pick" onClick={() => moves.resolveChoice(i)} />
                ));
            })()}
          </div>
        </div>
      )}
      {G.pendingChoice?.kind === 'select-card-in-inner-circle' && G.pendingChoice.playerId === me && (
        <div>
          <h3 style={{ margin: '4px 0', fontSize: 14, opacity: 0.85 }}>Inner Circle — pick one to devour</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {p.innerCircle.map((c, i) => (
              <Card key={i} card={c} label="devour" onClick={() => moves.resolveChoice(i)} />
            ))}
          </div>
        </div>
      )}
      <div onMouseEnter={enterMap} onMouseLeave={leaveMap} style={sectionBox('map')}>
        <MapView G={G}
          clickableSites={startingClickable} onSiteClick={handleSiteClick}
          highlightSites={highlightSites}
          clickableSpaces={clickableSpaces} onSpaceClick={handleSpaceClick} />
      </div>
      <div onMouseEnter={enterCards} onMouseLeave={leaveCards} style={sectionBox('cards')}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'center' }}>
          <div style={{ flex: '1 1 320px', minWidth: 280 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14, opacity: 0.85, display: 'flex', alignItems: 'baseline', gap: 12 }}>
              Your Hand ({p.hand.length})
              <button onClick={() => onViewPile('played')}
                title="View cards you played this turn"
                style={{
                  background: 'none', border: 'none', padding: 0, font: 'inherit',
                  color: '#a9c6ff', cursor: 'pointer', textDecoration: 'underline',
                  textUnderlineOffset: 2, fontSize: 12, fontWeight: 'normal'
                }}>
                Played: {p.cardsPlayed.length}
              </button>
            </h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
              {p.hand.map((c, i) => {
                // See same-named check in the play tab above — the
                // prompted player owns this choice (HUMAN_SEAT for forced
                // discards triggered on the human's hand during an AI turn).
                const isChoosing = G.pendingChoice?.kind === 'select-card-in-hand' && G.pendingChoice.playerId === me;
                const opts = isChoosing ? (G.pendingChoice!.options as number[] | undefined) : undefined;
                const eligible = !isChoosing || !opts || opts.includes(i);
                // Hide ineligible cards entirely when options restrict which cards are pickable
                // if (isChoosing && opts && !eligible) return null;
                const onClick = isChoosing
                  ? () => moves.resolveChoice(i)
                  : (myTurn && !G.pendingChoice ? () => playCardSafe(i) : undefined);
                const label = isChoosing ? 'pick' : 'play';
                return <Card key={i} card={c} label={label} onClick={onClick} dim={isChoosing && !eligible}/>;
              })}
            </div>
          </div>
          <div style={{ flex: '2 1 480px', minWidth: 360 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14, opacity: 0.85 }}>
              Market <span style={{ opacity: 0.6, fontWeight: 'normal' }}>· {G.market.deck.length} left in deck</span>
            </h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
              {G.market.row.map((c, i) => {
                if (!c) return <div key={i} style={{ width: 120, height: 168, margin: 4, border: '1px dashed #444', borderRadius: 8 }} />;
                const inPickMode = !!clickableMarketSlots;
                const slotPickable = inPickMode && clickableMarketSlots!.has(i);
                const cost = lookupCard(c.deck, c.slot)?.cost ?? '?';
                // Blocked while any OTHER prompt is outstanding — see the game
                // tab's market block for why.
                const blocked = !inPickMode && !!G.pendingChoice;
                const label = inPickMode
                  ? (slotPickable ? 'pick' : '—')
                  : blocked ? '—' : `recruit (${cost} Inf)`;
                const onClick = inPickMode
                  ? (slotPickable ? () => moves.resolveChoice(i) : undefined)
                  : (myTurn && !blocked ? () => moves.recruitFromMarket(i) : undefined);
                return <Card key={i} card={c} label={label} onClick={onClick} dim={(inPickMode && !slotPickable) || blocked} />;
              })}
              {(['houseGuards', 'priestesses'] as const).map(stack => {
                const ref = stack === 'houseGuards'
                  ? { deck: 'house-guards', slot: 40 }
                  : { deck: 'priestesses',  slot: 43 };
                const data = lookupCard(ref.deck, ref.slot);
                if (!data) return null;
                const card: CardRef = { deck: ref.deck, slot: ref.slot, name: data.name, image: data.image };
                const remaining = G.auxStacks?.[stack] ?? 0;
                const cost = data.cost ?? 999;
                // Sentinel picks from a free-recruit prompt; see main play
                // tab's equivalent block. -1 = House Guard, -2 = Priestess.
                const sentinel = stack === 'houseGuards' ? -1 : -2;
                const freeRecruitPickable = !!clickableMarketSlots && clickableMarketSlots.has(sentinel);
                const canRecruit = myTurn && remaining > 0 && p.influence >= cost && !G.pendingChoice;
                const label = remaining === 0
                  ? `empty · ${data.name}`
                  : freeRecruitPickable
                    ? `pick (free) · ${remaining} left`
                    : `recruit (${cost} Inf) · ${remaining} left`;
                const onClick = freeRecruitPickable
                  ? () => moves.resolveChoice(sentinel)
                  : canRecruit
                    ? () => moves.recruitFromAuxStack(stack)
                    : undefined;
                return (
                  <div key={stack} style={{ opacity: remaining === 0 ? 0.4 : 1 }}>
                    <Card card={card} label={label} onClick={onClick} dim={!!clickableMarketSlots && !freeRecruitPickable} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  // First-run gate: if a remote image source is configured and we haven't
  // imported yet, the bulk-import dialog renders on top and the rest of the
  // app waits behind it. Skipped entirely when no-images mode is on (the
  // placeholder card renders without needing any fetched art).
  const [imagesReady, setImagesReady] = useState<boolean>(() => {
    if (isNoImagesMode()) return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem('totu.image-cache-ready') === '1';
  });

  // Hot-seat mode: single tab, no playerID gating. P1 is the human; P2..PN are AI.
  // Mounting flow: if we have a saved game AND its config, jump straight back into
  // the Client (Board's useEffect will restore the codec). Otherwise show the
  // new-game dialog.
  const [config, setConfig] = useState<GameConfig | null>(() => {
    const save = localStorage.getItem(SAVE_KEY);
    if (!save) return null;
    // Prefer the explicit stored config; if absent (e.g. legacy save), derive
    // numPlayers from the codec and assume heuristic opponents.
    const cfg = loadConfig() ?? configFromSave(save);
    return cfg ?? null;
  });
  const [savedConfig] = useState<GameConfig | null>(() => {
    const save = localStorage.getItem(SAVE_KEY);
    return loadConfig() ?? (save ? configFromSave(save) : null);
  });

  function startNew(cfg: GameConfig) {
    localStorage.removeItem(SAVE_KEY);
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    // Best-effort play counter — local games are always one human seat plus AI
    // opponents. Fires once per new game (not on resume / reload / per move).
    recordPlay('tyrants', 'ai');
    setConfig(cfg);
  }

  function newGameFromSession() {
    localStorage.removeItem(SAVE_KEY);
    setConfig(null);
  }

  function resumeSaved() {
    if (savedConfig) setConfig(savedConfig);
  }

  return (
    <>
      {!imagesReady && <FirstRunImageImport onClose={() => setImagesReady(true)} />}
      {(() => {
        if (!config) {
          const hasSave = !!localStorage.getItem(SAVE_KEY) && !!savedConfig;
          return <NewGameDialog onStart={startNew} hasSave={hasSave} onResume={resumeSaved} lastConfig={savedConfig} />;
        }
        return <ClientHolder config={config} onNewGame={newGameFromSession} />;
      })()}
    </>
  );
}
