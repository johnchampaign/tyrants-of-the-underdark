import { useEffect, useRef, useState } from 'react';
import { SITES, type Site } from '../data/sites';
import { ROUTES, type Route } from '../data/routes';
import { sitesSpaces } from '../data/troop-spaces';
import type { TyrantsState, Color } from '../game';
import COMMITTED_SLOT_POSITIONS from '../../assets/slot-positions-auto.json';
import { useCachedImage } from '../image-cache';
import { isNoImagesMode } from '../App';
import { loadSectionDividers } from './SectionDividerCalibration';
import { loadMarkerPositions } from './MarkerCalibration';
import { hasTotalControl } from '../engine/map-state';

const COLOR_HEX: Record<Color, string> = {
  // Lifted toward grey so tokens contrast against near-black site boxes.
  black: '#4a4a4a',
  red: '#c2362e',
  orange: '#d97a1d',
  blue: '#2b53b0',
  // Extra colours human players may pick — chosen to stay distinct from each
  // other and from the canonical four against the dark board.
  purple: '#9b5de5',
  green: '#3fa34d',
  teal: '#1fb6b0',
  pink: '#e36bb0',
  yellow: '#d9c520',
};
// White tokens darkened toward light grey so they stand out on white-bordered site boxes.
const WHITE_TOKEN = '#d0d0d0';

// Samsung Internet / Chrome Android "Website dark mode" repaints solid
// background-COLORS but leaves background-IMAGES (gradients) alone. Painting a
// game-state token colour as a flat gradient keeps it exactly as authored even
// when the user forces the browser's dark mode on — otherwise black tokens get
// inverted to white and neutral tokens go grey/white inconsistently. Renders
// pixel-identical to a solid fill in every normal browser.
const flat = (c: string) => `linear-gradient(${c}, ${c})`;

const STORAGE_KEY = 'totu.site-positions';
const SLOTS_STORAGE_KEY = 'totu.slot-positions';

interface PositionOverride {
  [siteId: string]: { x: number; y: number };
}
interface SlotPositions {
  [spaceId: string]: { x: number; y: number };
}

function loadOverrides(): PositionOverride {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function saveOverrides(o: PositionOverride) { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); }
function loadSlotPositions(): SlotPositions {
  // Committed positions (in-repo file) provide the baseline; localStorage overrides any
  // individual slots the user has re-calibrated locally.
  let local: SlotPositions = {};
  try { local = JSON.parse(localStorage.getItem(SLOTS_STORAGE_KEY) || '{}'); } catch {}
  return { ...(COMMITTED_SLOT_POSITIONS as SlotPositions), ...local };
}

interface MapViewProps {
  calibrate?: boolean;
  /** When true, MapView becomes a route editor: click two sites to toggle an edge between them. */
  editRoutes?: boolean;
  G?: TyrantsState;
  /** Sites the user can click in the current context (e.g. empty starting sites during setup). */
  clickableSites?: Set<string>;
  onSiteClick?: (siteId: string) => void;
  /** Advisory subset of clickableSites: sites where the card's follow-up step
   *  (assassinate / supplant / "opponent troop here" bonus) actually has a
   *  target. Drawn as a solid, brighter ring; everything in clickableSites
   *  stays equally clickable. Report #105 — a spy spent on a site with no
   *  legal follow-up target used to look identical to a good one. */
  highlightSites?: Set<string>;
  /** Troop spaces the user can click (e.g. for assassinate/deploy/supplant prompts). */
  clickableSpaces?: Set<string>;
  onSpaceClick?: (spaceId: string) => void;
}

const ROUTES_STORAGE_KEY = 'totu.routes';

function loadRouteOverrides(): Route[] | null {
  try {
    const raw = localStorage.getItem(ROUTES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveRouteOverrides(r: Route[]) { localStorage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(r)); }

/** Sites with a printed control marker. The visual is rendered procedurally
 *  in `ControlMarkerToken` from each site's values, so no per-site asset
 *  files are required. */
const MARKER_SITES = new Set([
  'gauntlgrym', 'menzoberranzan', 'araumycos', 'chchitl',
  'phaerlin', 'sszuraassnee', 'tsenviilyq',
]);

/** Anchored overlay for a control marker on the image-mode board. Rendered
 *  entirely as inline SVG from the site's values — no image assets. Mimics
 *  the physical marker's visual hierarchy (decorative purple disc, central
 *  bonus glyph, side label at bottom) while giving us pixel-perfect control
 *  of which side is up and which per-site VP value is printed. The ring
 *  around the disc carries the holder color; total control thickens the
 *  ring and brightens its glow. */
function ControlMarkerToken(
  { siteId, x, y, controller, totalControl, totalControlInfluence, totalControlVp, controlInfluence, sizePx }:
  { siteId: string; x: number; y: number;
    controller: Color | null;
    totalControl: boolean;
    controlInfluence: number;
    totalControlInfluence: number; totalControlVp: number;
    /** Pixel size of the disc. The component is otherwise pure SVG so it
     *  scales naturally; the container size determines on-screen footprint
     *  and is passed by MapView so iPad / small-viewport renders shrink. */
    sizePx: number }
) {
  if (!MARKER_SITES.has(siteId)) return null;
  // Per revised rulebook the chit transfers (or returns to the map) the
  // instant control changes — so the holder always equals the controller.
  // One visual state per case: a solid coloured ring (with thicker stroke
  // and brighter halo on total control) for whoever currently controls, or
  // a thin gold "unclaimed" ring when nobody does.
  const ringColor = controller ? COLOR_HEX[controller] : 'rgba(255,204,68,0.65)';
  const borderWidth = !controller ? 2 : totalControl ? 6 : 3;
  const sideLabel = totalControl ? 'TOTAL CONTROL' : 'CONTROL';
  const inf = totalControl ? totalControlInfluence : controlInfluence;
  const vp = totalControl ? totalControlVp : 0;
  // Two-line center stack: "+N inf" (always) then "+N VP" (total-control only).
  return (
    <div title={`Control: +${controlInfluence} influence/turn. Total control: +${totalControlInfluence} influence/turn + ${totalControlVp} VP/turn.\n${
      controller ? `Held by ${controller}${totalControl ? ' (TOTAL CONTROL)' : ''}.` : 'On the map — unclaimed.'
    }`}
      style={{
        position: 'absolute',
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: 'translate(-50%, -50%)',
        width: sizePx, height: sizePx,
        pointerEvents: 'none', zIndex: 6,
        filter: controller
          ? `drop-shadow(0 0 ${totalControl ? 10 : 6}px ${ringColor})`
          : 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))',
      }}>
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        {/* Disc with the marker's signature deep-purple fill and a thin
            decorative inner ring to read as a chip, not a flat circle. */}
        <circle cx="50" cy="50" r="48" fill={totalControl ? '#3a2055' : '#241638'}
          stroke={ringColor} strokeWidth={borderWidth} />
        <circle cx="50" cy="50" r="42" fill="none"
          stroke="rgba(196,163,245,0.25)" strokeWidth="1" />
        {/* Center value stack. "+N" + drawn cobweb icon (influence); the VP
            line is drawn only on the total-control face. The cobweb is built
            from concentric arcs + radial spokes so it renders identically
            across browsers regardless of emoji-font coverage. */}
        <text x="42" y={vp > 0 ? 46 : 58} textAnchor="middle"
          fontSize="22" fontWeight="700" fill="#fff"
          fontFamily="Georgia, serif">+{inf}</text>
        <g transform={`translate(58, ${vp > 0 ? 40 : 52}) scale(1)`}>
          <circle cx="0" cy="0" r="6" fill="none" stroke="#fff" strokeWidth="0.7" />
          <circle cx="0" cy="0" r="4" fill="none" stroke="#fff" strokeWidth="0.6" />
          <circle cx="0" cy="0" r="2" fill="none" stroke="#fff" strokeWidth="0.5" />
          <line x1="-6" y1="0"    x2="6"  y2="0"    stroke="#fff" strokeWidth="0.5" />
          <line x1="0"  y1="-6"   x2="0"  y2="6"    stroke="#fff" strokeWidth="0.5" />
          <line x1="-4.2" y1="-4.2" x2="4.2" y2="4.2"  stroke="#fff" strokeWidth="0.5" />
          <line x1="-4.2" y1="4.2"  x2="4.2" y2="-4.2" stroke="#fff" strokeWidth="0.5" />
        </g>
        {vp > 0 && (
          <text x="50" y="68" textAnchor="middle"
            fontSize="18" fontWeight="700" fill="#ffd966"
            fontFamily="Georgia, serif">
            +{vp} VP
          </text>
        )}
        {/* Bottom arc label: which side is up. SVG textPath curving along an
            invisible arc near the marker's bottom rim, matching the printed
            marker's "CONTROL" / "TOTAL CONTROL" wraparound. */}
        <defs>
          <path id={`arc-${siteId}`} d="M 14 64 A 38 38 0 0 0 86 64" fill="none" />
        </defs>
        <text fontSize={totalControl ? 9 : 10} fontWeight="700"
          fill="rgba(255,255,255,0.85)" letterSpacing="1.5">
          <textPath href={`#arc-${siteId}`} startOffset="50%" textAnchor="middle">
            {sideLabel}
          </textPath>
        </text>
      </svg>
    </div>
  );
}

export function MapView({ calibrate = false, editRoutes = false, G, clickableSites, onSiteClick, highlightSites, clickableSpaces, onSpaceClick }: MapViewProps) {
  const boardUrl = useCachedImage('assets/board/map.jpg');
  const [overrides, setOverrides] = useState<PositionOverride>(loadOverrides);
  const [slotPositions] = useState<SlotPositions>(loadSlotPositions);
  const [dragging, setDragging] = useState<string | null>(null);
  const [routeDraft, setRouteDraft] = useState<Route[]>(() => loadRouteOverrides() ?? ROUTES);
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const [defaultSpaces, setDefaultSpaces] = useState(1);
  // Track the rendered board width so overlays (slot pips, marker discs,
  // spy/holder badges, site-pick rings) can scale proportionally. The board
  // image is width:100% capped at 1200px max; on smaller screens (iPad
  // portrait ~768px, landscape ~1024px) fixed pixel sizes that look right at
  // 1200px end up too chunky relative to the board. We track via
  // ResizeObserver so the sizes also follow window resizes without a reload.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [boardWidth, setBoardWidth] = useState<number>(1200);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setBoardWidth(el.getBoundingClientRect().width || 1200);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Scale factor relative to the design baseline (1200px wide). All fixed
  // pixel sizes below are multiplied by this so they shrink on smaller
  // viewports. Clamped to [0.3, 1.0]: the 0.3 floor lets overlays keep
  // shrinking proportionally on phone-width boards (the old 0.5 floor made
  // troops/pips oversized relative to a ~330px board), while the 1.0 cap
  // keeps full-width desktop boards at exact design size — mobile tuning
  // must lower the floor, not the ceiling.
  const scale = Math.max(0.3, Math.min(1.0, boardWidth / 1200));
  const px = (n: number) => Math.round(n * scale);
  // Control markers use their own width-proportional size instead of the
  // shared troop/pip `scale`. Their 110px desktop baseline is ~9% of a
  // 1200px board, but routing it through the shared floor(0.5) scale left
  // it at ~55px — ~17% of a phone-width (~330px) board, roughly double its
  // intended proportion (confirmed against a mobile screenshot: marker
  // diameter measured 155px against a 995px board image = 15.6%). Deriving
  // straight from boardWidth reproduces the desktop size (108px at 1200px)
  // while scaling smoothly down to phone widths; the 28px floor keeps it
  // legible/tappable on extreme narrow viewports (e.g. split-screen).
  const markerSizePx = Math.max(28, Math.round(boardWidth * 0.09));
  // Rulebook p.5: hide sites/routes outside this game's active sections. Calibrate
  // / editRoutes modes ignore this so all sites stay reachable for setup work.
  const activeSites = (G && !calibrate && !editRoutes)
    ? new Set(G.activeSites)
    : new Set(SITES.map(s => s.id));
  const isSiteActive = (id: string) => activeSites.has(id);
  const isRouteActive = (r: { a: string; b: string }) => activeSites.has(r.a) && activeSites.has(r.b);

  const activeRoutes = (editRoutes ? routeDraft : ROUTES).filter(r => isRouteActive(r));

  const pos = (s: Site) => overrides[s.id] ?? { x: s.x, y: s.y };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const board = document.getElementById('totu-board') as HTMLImageElement | null;
      if (!board) return;
      const rect = board.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      setOverrides(o => ({ ...o, [dragging]: { x, y } }));
    };
    const onUp = () => { setDragging(null); saveOverrides(overrides); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging, overrides]);

  function clickSiteForRouteEdit(siteId: string) {
    if (!pendingFrom) { setPendingFrom(siteId); return; }
    if (pendingFrom === siteId) { setPendingFrom(null); return; }
    const a = pendingFrom, b = siteId;
    const exists = routeDraft.find(r => (r.a === a && r.b === b) || (r.a === b && r.b === a));
    let next: Route[];
    if (exists) {
      next = routeDraft.filter(r => r !== exists);
    } else {
      const id = `${a}-${b}`;
      next = [...routeDraft, { id, a, b, spaces: defaultSpaces }];
    }
    setRouteDraft(next);
    saveRouteOverrides(next);
    setPendingFrom(null);
  }

  function exportRoutes() {
    const lines = routeDraft.map(r =>
      `  { id: '${r.id}', a: '${r.a}', b: '${r.b}', spaces: ${r.spaces} },`
    );
    const out = `// Paste over ROUTES in src/data/routes.ts\nexport const ROUTES: Route[] = [\n${lines.join('\n')}\n];\n`;
    navigator.clipboard.writeText(out);
    alert(`Copied ${routeDraft.length} routes to clipboard.`);
  }

  function exportPositions() {
    const lines = SITES.map(s => {
      const p = pos(s);
      return `  '${s.id}': { x: ${p.x.toFixed(3)}, y: ${p.y.toFixed(3)} },`;
    });
    const out = `// Paste into sites.ts to lock calibrated positions.\n{\n${lines.join('\n')}\n}\n`;
    navigator.clipboard.writeText(out);
    alert('Calibrated positions copied to clipboard.');
  }

  // No-images mode replaces the printed board with a schematic spacer —
  // same aspect ratio so all the calibrated coordinates still land correctly;
  // a dark background with route lines drawn between sites; site labels show
  // their name+VP where the printed art would. Tokens, spies, markers etc.
  // all still render on top via the regular passes below.
  const useSchematic = isNoImagesMode() && !calibrate && !editRoutes;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', maxWidth: 1200, margin: '0 auto' }}>
      {useSchematic ? (
        <div id="totu-board" style={{
          width: '100%', aspectRatio: '4646 / 4605',
          background: 'radial-gradient(ellipse at center, #2a1840 0%, #0c0814 90%)',
          border: '1px solid #3a2055',
          position: 'relative',
        }}>
          {/* Route lines drawn between every active site pair. */}
          <svg viewBox="0 0 1000 1000" preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            {activeRoutes.map(r => {
              const a = pos(SITES.find(s => s.id === r.a)!);
              const b = pos(SITES.find(s => s.id === r.b)!);
              if (!a || !b) return null;
              return <line key={r.id}
                x1={a.x * 1000} y1={a.y * 1000} x2={b.x * 1000} y2={b.y * 1000}
                stroke="rgba(196,163,245,0.35)" strokeWidth={2} />;
            })}
          </svg>
          {/* Site cards — name + slots enclosed by a single border. Schematic
              mode lays site spaces out inside the card itself so the user
              sees the slot pips as part of the site instead of as floating
              dots near where the printed art would have been. The full card
              is clickable for site-pick prompts; each slot dot is
              individually clickable for space-pick prompts. */}
          {G && SITES.filter(s => isSiteActive(s.id)).map(s => {
            const p = pos(s);
            const isClickable = !!clickableSites?.has(s.id);
            // #105: schematic mode has no ring overlay, so the follow-up
            // highlight rides on the site card's own border instead.
            const isHighlit = isClickable && !!highlightSites?.has(s.id);
            const controller = G.siteControl[s.id] ?? null;
            const spaces = sitesSpaces(s.id);
            return (
              <div key={s.id} style={{
                position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`,
                transform: 'translate(-50%, -50%)',
                padding: '4px 8px',
                background: 'rgba(20, 14, 40, 0.92)',
                color: '#e6e1f2',
                border: isHighlit ? '3px solid #66ff9e'
                  : isClickable ? '2px solid #ffcc44'
                  : controller ? `2px solid ${COLOR_HEX[controller]}`
                  : s.isStartingSite ? '1px solid #ffcc44'
                  : '1px solid #5a3380',
                borderRadius: 8,
                boxShadow: isHighlit ? '0 0 14px rgba(102, 255, 158, 0.9)'
                  : isClickable ? '0 0 10px #ffcc44' : undefined,
                cursor: isClickable ? 'pointer' : 'default',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                whiteSpace: 'nowrap',
                zIndex: 5,
              }}
                onClick={() => { if (isClickable) onSiteClick?.(s.id); }}
                title={isHighlit ? `${s.name} — the card's follow-up has a target here` : undefined}>
                <div style={{ fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>{s.name}</span>
                  <span style={{ opacity: 0.6 }}>({s.vp})</span>
                  {/* Schematic marker stack: a two-row chip pair mirroring
                      the two faces of the physical marker. The active face
                      (current control state) gets the holder color and a
                      bright border; the inactive face is dimmed. Mirrors the
                      image-mode SVG marker's information without requiring
                      a circular disc on a text-based site card. */}
                  {s.hasControlMarker && G.controlMarkers[s.id] && (() => {
                    const m = G.controlMarkers[s.id];
                    // Chit holder == current controller per the revised
                    // rulebook (immediate transfer / return-to-map on tie),
                    // so a single state drives both chips.
                    const controller = G.siteControl[s.id] ?? null;
                    const tc = controller ? hasTotalControl(G, controller, s.id) : false;
                    const activeColor = controller ? COLOR_HEX[controller] : '#ffcc44';
                    const fontText = controller === 'black' ? '#fff' : '#1a1228';
                    const dim = { background: 'rgba(20,14,40,0.85)', color: 'rgba(230,225,242,0.7)', border: '1px solid #5a3380' };
                    const lit = { background: activeColor, color: fontText, border: '1px solid #fff' };
                    const cStyle = (controller && !tc) ? lit : dim;
                    const tcStyle = tc ? lit : dim;
                    return (
                      <span title={`Control face: +${m.controlInfluence} influence (and +${m.controlVp} VP) when paid this turn.\nTotal-control face: +${m.totalControlInfluence} influence + ${m.totalControlVp} VP when paid this turn.\n${
                        controller ? `Held by ${controller}${tc ? ' (TOTAL CONTROL)' : ''}.` : 'On the map — unclaimed.'
                      }`}
                        style={{ display: 'inline-flex', flexDirection: 'column', gap: 1, fontSize: 8, fontWeight: 700, lineHeight: 1.1 }}>
                        <span style={{ ...cStyle, borderRadius: 2, padding: '0 4px', letterSpacing: 0.3 }}>
                          C +{m.controlInfluence}inf
                        </span>
                        <span style={{ ...tcStyle, borderRadius: 2, padding: '0 4px', letterSpacing: 0.3 }}>
                          TC +{m.totalControlInfluence}inf{m.totalControlVp > 0 ? ` +${m.totalControlVp}VP` : ''}
                        </span>
                      </span>
                    );
                  })()}
                </div>
                <div style={{ display: 'flex', gap: 3 }}>
                  {spaces.map((sp, i) => {
                    const occ = G.troops[sp.id];
                    const spClick = !!clickableSpaces?.has(sp.id);
                    const sz = px(spClick ? 16 : 14);
                    return (
                      <div key={sp.id}
                        onClick={(e) => { if (spClick) { e.stopPropagation(); onSpaceClick?.(sp.id); } }}
                        title={`${s.name} — slot ${i + 1}${occ ? ` · ${occ}` : ''}`}
                        style={{
                          width: sz, height: sz, borderRadius: '50%',
                          background: occ === 'white' ? flat(WHITE_TOKEN)
                            : occ ? flat(COLOR_HEX[occ])
                            : 'transparent',
                          border: spClick ? '2px solid #ffcc44'
                            : occ === 'black' ? '2px solid #e6e1f2'
                            : occ ? '2px solid #fff'
                            : '1px dashed rgba(255,255,255,0.35)',
                          boxShadow: spClick ? '0 0 6px #ffcc44' : undefined,
                          cursor: spClick ? 'pointer' : 'default',
                        }} />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <img id="totu-board" src={boardUrl} alt="game board" style={{ width: '100%', display: 'block', userSelect: 'none' }} draggable={false} />
      )}

      {/* Inactive-section dimmer. The printed board image is always the whole map,
          but in 2P (center only) and 3P (center + one outer) some sections are
          out of play. We darken those regions using calibrated polylines that
          follow the printed dashed-purple section boundaries. Falls back to a
          vertical midpoint cut if a polyline has fewer than 2 points (i.e.
          hasn't been calibrated yet). */}
      {G && !calibrate && !editRoutes && (() => {
        const sectionsInPlay = new Set(SITES.filter(s => activeSites.has(s.id)).map(s => s.section));
        if (sectionsInPlay.size >= 3) return null;
        const inactive = (['left','center','right'] as const).filter(sec => !sectionsInPlay.has(sec));
        const dividers = loadSectionDividers();
        // Build x-fallback midpoints if we need them.
        const bounds: Record<'left'|'center'|'right', { min: number; max: number } | null> = {
          left: null, center: null, right: null,
        };
        for (const s of SITES) {
          const p = pos(s);
          const b = bounds[s.section];
          if (!b) bounds[s.section] = { min: p.x, max: p.x };
          else { b.min = Math.min(b.min, p.x); b.max = Math.max(b.max, p.x); }
        }
        const midLC = bounds.left && bounds.center ? (bounds.left.max + bounds.center.min) / 2 : 0.33;
        const midCR = bounds.center && bounds.right ? (bounds.center.max + bounds.right.min) / 2 : 0.66;
        // Extend a polyline to span y=0..1 by clamping (vertical line from
        // first/last point) so the polygon always closes against board edges.
        function extendVertical(pts: { x: number; y: number }[]): { x: number; y: number }[] {
          if (pts.length === 0) return [];
          const sorted = [...pts].sort((a, b) => a.y - b.y);
          const out: { x: number; y: number }[] = [];
          if (sorted[0].y > 0) out.push({ x: sorted[0].x, y: 0 });
          out.push(...sorted);
          if (sorted[sorted.length - 1].y < 1) out.push({ x: sorted[sorted.length - 1].x, y: 1 });
          return out;
        }
        // Build the polygon (in normalized 0..1) covering `sec`. The polygon
        // goes top-down along the left edge (board edge or LC divider), then
        // bottom-up along the right edge (CR divider or board edge).
        function polygonFor(sec: 'left'|'center'|'right'): string {
          const lc = extendVertical(dividers.leftCenter);
          const cr = extendVertical(dividers.centerRight);
          const useLC = lc.length >= 2;
          const useCR = cr.length >= 2;
          // left edge of this section's polygon, top→bottom
          let leftEdge: { x: number; y: number }[];
          // right edge, top→bottom (we'll reverse for polygon traversal)
          let rightEdge: { x: number; y: number }[];
          if (sec === 'left') {
            leftEdge = [{ x: 0, y: 0 }, { x: 0, y: 1 }];
            rightEdge = useLC ? lc : [{ x: midLC, y: 0 }, { x: midLC, y: 1 }];
          } else if (sec === 'right') {
            leftEdge = useCR ? cr : [{ x: midCR, y: 0 }, { x: midCR, y: 1 }];
            rightEdge = [{ x: 1, y: 0 }, { x: 1, y: 1 }];
          } else {
            leftEdge = useLC ? lc : [{ x: midLC, y: 0 }, { x: midLC, y: 1 }];
            rightEdge = useCR ? cr : [{ x: midCR, y: 0 }, { x: midCR, y: 1 }];
          }
          const ring = [...leftEdge, ...[...rightEdge].reverse()];
          return ring.map(p => `${p.x * 100}% ${p.y * 100}%`).join(', ');
        }
        // Pick an interior point of the polygon for the "OUT OF PLAY" label.
        // Use the centroid of the polygon's points.
        function labelPosition(sec: 'left'|'center'|'right'): { x: number; y: number } {
          const poly = polygonFor(sec).split(', ').map(s => {
            const [xs, ys] = s.split(' ');
            return { x: parseFloat(xs) / 100, y: parseFloat(ys) / 100 };
          });
          const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
          const cy = poly.reduce((a, p) => a + p.y, 0) / poly.length;
          return { x: cx, y: cy };
        }
        return inactive.map(sec => {
          const clip = polygonFor(sec);
          const lp = labelPosition(sec);
          return (
            <div key={`dim-${sec}`} style={{
              position: 'absolute', inset: 0,
              background: 'rgba(8, 4, 18, 0.72)',
              clipPath: `polygon(${clip})`,
              WebkitClipPath: `polygon(${clip})`,
              pointerEvents: 'none',
              zIndex: 4,
            }}>
              <div style={{
                position: 'absolute',
                top: `${lp.y * 100}%`, left: `${lp.x * 100}%`,
                transform: 'translate(-50%, -50%)',
                padding: '4px 10px', fontSize: 11, color: '#c4a3f5',
                background: 'rgba(20, 14, 40, 0.85)', border: '1px solid #3a2055', borderRadius: 4,
                letterSpacing: 1, textTransform: 'uppercase',
              }}>
                out of play
              </div>
            </div>
          );
        });
      })()}

      {/* Routes overlay — only drawn in editor mode (the printed board already shows them).
          In normal play the route troop spaces along the printed lines are what matter. */}
      {editRoutes && (
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} viewBox="0 0 1 1" preserveAspectRatio="none">
          {activeRoutes.map(r => {
            const a = SITES.find(s => s.id === r.a);
            const b = SITES.find(s => s.id === r.b);
            if (!a || !b) return null;
            const pa = pos(a); const pb = pos(b);
            return <line key={r.id} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
              stroke="rgba(120, 220, 120, 0.9)" strokeWidth={0.005} />;
          })}
        </svg>
      )}

      {/* Route-space troop pips. Use calibrated position if available, else interpolate
          linearly between the two endpoint sites. */}
      {G && !editRoutes && activeRoutes.flatMap(r => {
        const a = SITES.find(s => s.id === r.a);
        const b = SITES.find(s => s.id === r.b);
        if (!a || !b) return [];
        const pa = pos(a), pb = pos(b);
        return Array.from({ length: r.spaces }, (_, i) => {
          const spaceId = `${r.id}:${i}`;
          // Schematic mode: ignore calibrated positions (they were authored
          // against the printed board's curvy routes). Pin slots evenly along
          // the straight schematic line so they sit exactly on the rendered
          // route, instead of floating off it.
          const calibrated = useSchematic ? undefined : slotPositions[spaceId];
          let x: number, y: number;
          if (calibrated) {
            x = calibrated.x; y = calibrated.y;
          } else {
            const t = (i + 1) / (r.spaces + 1);
            x = pa.x + (pb.x - pa.x) * t;
            y = pa.y + (pb.y - pa.y) * t;
          }
          const occ = G.troops[spaceId];
          const pickable = clickableSpaces?.has(spaceId);
          const size = px(pickable ? 26 : 22);
          return (
            <div key={spaceId}
              onClick={() => { if (pickable) onSpaceClick?.(spaceId); }}
              title={spaceId}
              style={{
                position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`,
                width: size, height: size, marginLeft: -size/2, marginTop: -size/2,
                borderRadius: '50%',
                background: occ === 'white' ? flat(WHITE_TOKEN) : occ ? flat(COLOR_HEX[occ]) : 'rgba(20, 14, 40, 0.7)',
                border: pickable ? '2px solid #ffcc44' : occ ? '1px solid #fff' : '1px solid rgba(255,255,255,0.3)',
                boxShadow: pickable ? '0 0 6px #ffcc44' : undefined,
                cursor: pickable ? 'pointer' : 'default',
                zIndex: 5,
              }} />
          );
        });
      })}

      {/* Control-marker overlay (image mode only). For each control-marker
          site, anchor the marker token image to the upper-left of the site
          position. If a player holds the marker, ring it in their color and
          show "X/Y" VP underneath. The schematic mode shows the same info
          inline on the site card, so this overlay is skipped there. */}
      {!editRoutes && !useSchematic && G && (() => {
        // Per-site marker overrides from the markers calibration tab. Falls
        // back to (site position + small y nudge) when not set.
        const markerPositions = loadMarkerPositions();
        return SITES.filter(s => isSiteActive(s.id) && s.hasControlMarker).map(s => {
          const m = G.controlMarkers[s.id];
          if (!m) return null;
          const sp = pos(s);
          const override = markerPositions[s.id];
          const mx = override?.x ?? sp.x;
          const my = override?.y ?? (sp.y + 0.025);
          // Controller is now the single source of truth: the chit moves
          // to the controller immediately on every control change, and
          // returns to the map if the site becomes uncontrolled. So
          // m.holder == G.siteControl[s.id] always (no stale holder state).
          const controller = G.siteControl[s.id] ?? null;
          const tc = controller ? hasTotalControl(G, controller, s.id) : false;
          return (
            <ControlMarkerToken key={`marker-${s.id}`}
              siteId={s.id} x={mx} y={my}
              controller={controller}
              totalControl={tc}
              controlInfluence={m.controlInfluence}
              totalControlInfluence={m.totalControlInfluence}
              totalControlVp={m.totalControlVp}
              sizePx={markerSizePx} />
          );
        });
      })()}

      {/* Calibrate/route-edit mode keeps the labeled site rectangle visible for dragging
          and route picking. Normal play hides it; tokens render directly on calibrated
          slot positions on the printed board. */}
      {(calibrate || editRoutes) && SITES.filter(s => isSiteActive(s.id)).map(s => {
        const p = pos(s);
        const controller = G?.siteControl[s.id] ?? null;
        const borderColor = controller ? COLOR_HEX[controller] : (s.isStartingSite ? '#ffcc44' : 'rgba(196,163,245,0.5)');
        const isRouteEditPending = editRoutes && pendingFrom === s.id;
        return (
          <div
            key={s.id}
            onMouseDown={() => calibrate && setDragging(s.id)}
            onClick={() => { if (editRoutes) clickSiteForRouteEdit(s.id); }}
            style={{
              position: 'absolute',
              left: `${p.x * 100}%`,
              top: `${p.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              padding: '2px 6px',
              fontSize: 11,
              background: isRouteEditPending ? 'rgba(120, 220, 120, 0.95)' : 'rgba(20, 14, 40, 0.85)',
              color: '#fff',
              border: `${controller ? 2 : 1}px solid ${isRouteEditPending ? '#7adc7a' : borderColor}`,
              borderRadius: 4,
              cursor: calibrate ? 'grab' : 'pointer',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              boxShadow: isRouteEditPending ? '0 0 12px rgba(120, 220, 120, 0.7)' : undefined,
            }}
            title={`${s.name} — ${s.vp} VP, ${s.troopSlots} slots`}
          >
            {s.name} <span style={{ opacity: 0.7 }}>({s.vp})</span>
          </div>
        );
      })}

      {/* Site-slot tokens: one per space, positioned exactly on the printed slot.
          Falls back to an offset cluster around the site center if not calibrated.
          Suppressed in schematic mode — the in-card slot dots above handle both
          rendering and clicks. */}
      {!editRoutes && !useSchematic && G && SITES.filter(s => isSiteActive(s.id)).flatMap(s => {
        const sitePos = pos(s);
        const controller = G.siteControl[s.id] ?? null;
        return sitesSpaces(s.id).map((sp, i) => {
          const calibrated = slotPositions[sp.id];
          let x: number, y: number;
          if (calibrated) {
            x = calibrated.x; y = calibrated.y;
          } else {
            // Fallback layout below the site label, 3 per row, ~1.5% spacing
            const col = i % 3;
            const row = Math.floor(i / 3);
            x = sitePos.x + (col - 1) * 0.018;
            y = sitePos.y + 0.020 + row * 0.018;
          }
          const occ = G.troops[sp.id];
          const isSpacePickable = clickableSpaces?.has(sp.id);
          // Slot clicks now ONLY satisfy troop-space picks. Site picks have a
          // dedicated overlay below so the user can tell which they're targeting.
          const pickable = isSpacePickable;
          const onClick = () => {
            if (isSpacePickable) onSpaceClick?.(sp.id);
          };
          const size = px(pickable ? 26 : 22);
          // While a site-pick is active, let clicks fall through non-pickable
          // slots to the site overlay disc underneath. Otherwise the user has
          // to aim outside the slots to hit the ring.
          const passThrough = !!(clickableSites && clickableSites.has(s.id) && !isSpacePickable);
          return (
            <div key={sp.id}
              onClick={onClick}
              title={`${s.name} — slot ${i + 1}${occ ? ` · ${occ}` : ''}${controller ? ` · ctrl ${controller}` : ''}`}
              style={{
                position: 'absolute',
                left: `${x * 100}%`,
                top: `${y * 100}%`,
                width: size, height: size,
                marginLeft: -size/2, marginTop: -size/2,
                borderRadius: '50%',
                background: occ === 'white' ? flat(WHITE_TOKEN)
                  : occ ? flat(COLOR_HEX[occ])
                  : 'transparent',
                border: pickable ? '2px solid #ffcc44'
                  : occ === 'black' ? '2px solid #e6e1f2'
                  : occ ? '2px solid #fff'
                  : '1px dashed rgba(255,255,255,0.25)',
                boxShadow: pickable ? '0 0 8px #ffcc44'
                  : occ === 'black' ? '0 0 0 1px #000, 0 1px 4px rgba(255,255,255,0.5)'
                  : occ ? '0 1px 3px rgba(0,0,0,0.6)'
                  : undefined,
                cursor: pickable ? 'pointer' : 'default',
                pointerEvents: passThrough ? 'none' : 'auto',
                zIndex: 10,
              }} />
          );
        });
      })}

      {/* Site-pick overlay: a large translucent ring on each clickable site, rendered
          ONLY while a site-level prompt is active (e.g. "place a spy at which site?",
          "return a spy from which site?"). Distinct from the slot tokens, which only
          satisfy troop-space picks. Prevents the slot/site click conflation that made
          Spellspinner-style supplant chains require two clicks (one for spy-return
          site, one for supplant troop) on the same visual location. */}
      {!editRoutes && !useSchematic && G && clickableSites && clickableSites.size > 0 && SITES.filter(s => isSiteActive(s.id)).map(s => {
        if (!clickableSites.has(s.id)) return null;
        const p = pos(s);
        const spaces = sitesSpaces(s.id);
        let cx = p.x, cy = p.y;
        const calibrated = spaces.map(sp => slotPositions[sp.id]).filter(Boolean) as { x: number; y: number }[];
        if (calibrated.length > 0) {
          const centroidX = calibrated.reduce((a, b) => a + b.x, 0) / calibrated.length;
          const centroidY = calibrated.reduce((a, b) => a + b.y, 0) / calibrated.length;
          cx = (p.x + centroidX) / 2;
          cy = (p.y + centroidY) / 2;
        }
        const isHighlit = !!highlightSites?.has(s.id);
        return (
          <div key={`site-pick-${s.id}`}
            onClick={() => onSiteClick?.(s.id)}
            title={isHighlit ? `Pick site: ${s.name} — the card's follow-up has a target here`
                             : `Pick site: ${s.name}`}
            style={{
              position: 'absolute',
              left: `${cx * 100}%`,
              top: `${cy * 100}%`,
              width: px(88), height: px(88),
              marginLeft: -px(44), marginTop: -px(44),
              borderRadius: '50%',
              border: isHighlit ? '4px solid #66ff9e' : '3px dashed #ffcc44',
              background: isHighlit ? 'rgba(102, 255, 158, 0.18)' : 'rgba(255, 204, 68, 0.12)',
              boxShadow: isHighlit ? '0 0 22px rgba(102, 255, 158, 0.85)' : '0 0 16px rgba(255, 204, 68, 0.6)',
              cursor: 'pointer',
              zIndex: 9,
              animation: 'tot-site-pulse 1.4s ease-in-out infinite',
            }} />
        );
      })}
      <style>{`
        @keyframes tot-site-pulse {
          0%, 100% { box-shadow: 0 0 16px rgba(255, 204, 68, 0.6); }
          50%      { box-shadow: 0 0 24px rgba(255, 204, 68, 0.95); }
        }
      `}</style>

      {/* Spies and held control markers: render between the site label and the slot
          row, centered on the site's printed art. We use the midpoint of the site
          label position and the slot centroid, which lands on the round-image center
          for control-marker sites and just below the label for rectangular ones. */}
      {!editRoutes && G && SITES.filter(s => isSiteActive(s.id)).map(s => {
        const p = pos(s);
        const spies = G.spies[s.id] ?? [];
        // The control-marker holder is already shown by the ControlMarkerToken
        // disc's coloured ring (image mode) / chip pair (schematic), so we no
        // longer paint a separate little holder dot here — it was redundant
        // visual noise on top of the ring colour. Only spies render in this pass.
        if (spies.length === 0) return null;
        // Slot centroid (calibrated slots) or fall back to label position.
        const spaces = sitesSpaces(s.id);
        let centroidX = p.x, centroidY = p.y;
        const calibrated = spaces.map(sp => slotPositions[sp.id]).filter(Boolean) as { x: number; y: number }[];
        if (calibrated.length > 0) {
          centroidX = calibrated.reduce((a, b) => a + b.x, 0) / calibrated.length;
          centroidY = calibrated.reduce((a, b) => a + b.y, 0) / calibrated.length;
        }
        const cx = (p.x + centroidX) / 2;
        const cy = (p.y + centroidY) / 2;
        return (
          <div key={`s${s.id}`}
            title={`${s.name}${spies.length ? ` · spies: ${spies.join(',')}` : ''}`}
            style={{
              position: 'absolute',
              left: `${cx * 100}%`,
              top: `${cy * 100}%`,
              transform: 'translate(-50%, -50%)',
              display: 'flex', gap: 2,
              zIndex: 11, pointerEvents: 'none',
            }}>
            {spies.map((sp, i) => (
              <span key={i} title={`spy: ${sp}`} style={{
                width: px(24), height: px(24), background: COLOR_HEX[sp],
                border: '2px solid #fff',
                boxShadow: '0 1px 4px rgba(0,0,0,0.7)',
              }} />
            ))}
          </div>
        );
      })}

      {calibrate && (
        <div style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.7)', padding: 8, borderRadius: 4 }}>
          <div style={{ fontSize: 11, marginBottom: 4 }}>Drag markers. Saved to localStorage.</div>
          <button onClick={exportPositions} style={{ fontSize: 11, padding: '4px 8px' }}>Copy positions to clipboard</button>
          <button onClick={() => { localStorage.removeItem(STORAGE_KEY); setOverrides({}); }} style={{ fontSize: 11, padding: '4px 8px', marginLeft: 4 }}>Reset</button>
        </div>
      )}
      {editRoutes && (
        <div style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.8)', padding: 8, borderRadius: 4, maxWidth: 280 }}>
          <div style={{ fontSize: 11, marginBottom: 6 }}>
            Click two sites to add/remove an edge between them.
            {pendingFrom && <div style={{ marginTop: 4, color: '#7adc7a' }}>From: {SITES.find(s => s.id === pendingFrom)?.name}</div>}
          </div>
          <div style={{ fontSize: 11, marginBottom: 6 }}>
            Default spaces on new routes:
            <input type="number" min={1} max={4} value={defaultSpaces}
              onChange={e => setDefaultSpaces(Math.max(1, Math.min(4, +e.target.value || 1)))}
              style={{ width: 40, marginLeft: 4 }} />
          </div>
          <div style={{ fontSize: 11, marginBottom: 6, opacity: 0.7 }}>
            {routeDraft.length} routes (was {ROUTES.length}).
          </div>
          <button onClick={exportRoutes} style={{ fontSize: 11, padding: '4px 8px' }}>Copy routes to clipboard</button>
          <button
            onClick={() => {
              if (!confirm(`Discard all ${routeDraft.length} route edits and reload from source file? This cannot be undone.`)) return;
              localStorage.removeItem(ROUTES_STORAGE_KEY);
              setRouteDraft(ROUTES);
              setPendingFrom(null);
            }}
            style={{ fontSize: 11, padding: '4px 8px', marginLeft: 4, background: '#5a1f1f', color: '#fdd', border: '1px solid #802626' }}
            title="Wipes all in-progress route edits"
          >
            Reset to file
          </button>
          <details style={{ marginTop: 8, fontSize: 10 }}>
            <summary>Per-route space counts</summary>
            <div style={{ maxHeight: 200, overflow: 'auto', marginTop: 4 }}>
              {routeDraft.map((r, i) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 1 }}>
                  <span style={{ flex: 1, fontSize: 10 }}>{r.a} ↔ {r.b}</span>
                  <input type="number" min={1} max={4} value={r.spaces}
                    onChange={e => {
                      const next = [...routeDraft];
                      next[i] = { ...r, spaces: Math.max(1, Math.min(4, +e.target.value || 1)) };
                      setRouteDraft(next); saveRouteOverrides(next);
                    }}
                    style={{ width: 36, fontSize: 10 }} />
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
