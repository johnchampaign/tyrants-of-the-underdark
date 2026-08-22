import { useEffect, useState } from 'react';
import { useIdentity, Leaderboard, SignInBar } from 'digital-boardgame-framework/client';
import { createGame, fetchStatus, deleteGame, type Invites } from './client';
import { listMyGames, rememberCreatedGame, forgetGame, type MyGame } from './myGames';
import type { PlayerId } from '../adapter/tyrantsAdapter';
import { HALF_DECKS, EXPANSION_HALF_DECKS, type HalfDeck } from '../half-decks';
import { SELECTABLE_COLORS, type Color } from '../game';

const COLOR_NAMES = ['Black', 'Red', 'Orange', 'Blue'];

/** What occupies a seat at creation time. 'human' means an invite link; any
 *  other value is a difficulty key from the server's AI controllers. */
type SeatFill = 'human' | 'random' | 'standard';
const SEAT_FILL_LABEL: Record<SeatFill, string> = {
  human: 'Human',
  random: 'Bot · easy',
  standard: 'Bot · standard',
};

export function Lobby() {
  const [numPlayers, setNumPlayers] = useState(2);
  // Per-seat fill. Seat 0 is always the creator; every other seat is either a
  // human (gets an invite link) or a server-driven bot. The create API has
  // always accepted an arbitrary seat->difficulty map — the lobby just never
  // offered anything except "all human" and a fixed 1v1 vs-AI preset, which is
  // exactly what the feature request was about.
  const [seatFill, setSeatFill] = useState<Record<number, SeatFill>>({ 1: 'human', 2: 'human', 3: 'human' });
  // Same setup choices the solo/hotseat dialog offers. Online had none of them:
  // the create endpoint ignored decks entirely, so every online game was the
  // default pair and nobody could play elemental or demons against a friend.
  const [halfDecks, setHalfDecks] = useState<HalfDeck[]>(['drow', 'dragons']);
  const [humanColor, setHumanColor] = useState<Color>(SELECTABLE_COLORS[0]);

  // Keep the two most recent picks, so clicking a third swaps the older out
  // rather than silently doing nothing.
  const toggleDeck = (d: HalfDeck) =>
    setHalfDecks(cur => cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d].slice(-2));
  const randomizeDecks = () =>
    setHalfDecks([...HALF_DECKS].sort(() => Math.random() - 0.5).slice(0, 2));
  const [game, setGame] = useState<Invites | null>(null);
  // Which seats the CREATED game gave to bots. Kept separately from seatFill so
  // that fiddling with the pickers afterwards can't mislabel a live game's
  // invite list. Bot seats get a token from the server like everyone else, but
  // there is nobody to send it to.
  const [createdBots, setCreatedBots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /** The seats the creator marked as bots, in the API's seat->difficulty shape. */
  function aiMap(): Partial<Record<PlayerId, string>> {
    const ai: Record<string, string> = {};
    for (let seat = 1; seat < numPlayers; seat++) {
      const fill = seatFill[seat] ?? 'human';
      if (fill !== 'human') ai[String(seat)] = fill;
    }
    return ai as Partial<Record<PlayerId, string>>;
  }

  const botSeats = aiMap();
  const botCount = Object.keys(botSeats).length;
  const humanCount = numPlayers - botCount;

  async function onCreate() {
    setBusy(true);
    setErr(null);
    try {
      const g = await createGame(numPlayers, botCount ? botSeats : undefined,
        { halfDecks, humanColor });
      rememberCreatedGame(g.gameId, g.invites);
      setCreatedBots(Object.keys(botSeats));
      // Nobody else to invite — drop straight into our own seat, the way the
      // old vs-AI button did. Deliberately leaves `busy` set: we're navigating
      // away, and clearing it would flash the button back to enabled first.
      if (humanCount === 1) {
        window.location.href = g.invites['0'];
        return;
      }
      setGame(g);
      setReloadKey((k) => k + 1);
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 700 }}>
      <h1>Tyrants of the Underdark — Online</h1>
      <SignInBar />
      <p style={{ color: '#aab' }}>
        Minimal async multiplayer. Pick a player count, create a game, send one
        link per seat (or open them in separate tabs).
      </p>
      <p style={{ marginTop: -4 }}>
        <a href="/" style={{ color: '#6cf' }}>← Play solo / vs AI / hotseat (main game)</a>
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <span>Players:</span>
        {[2, 3, 4].map((n) => (
          <button
            key={n}
            onClick={() => setNumPlayers(n)}
            style={{ ...mini, ...(numPlayers === n ? { background: '#5a3380', color: 'white' } : {}) }}
          >
            {n}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        {Array.from({ length: numPlayers }, (_, seat) => (
          <div key={seat} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <span style={{ width: 110, color: '#aab', fontSize: 13 }}>
              Seat {seat} ({COLOR_NAMES[seat]})
            </span>
            {seat === 0 ? (
              <span style={{ ...mini, background: '#5a3380', color: 'white', cursor: 'default' }}>You</span>
            ) : (
              (['human', 'random', 'standard'] as SeatFill[]).map((fill) => (
                <button
                  key={fill}
                  onClick={() => setSeatFill((m) => ({ ...m, [seat]: fill }))}
                  style={{ ...mini, ...((seatFill[seat] ?? 'human') === fill ? { background: '#5a3380', color: 'white' } : {}) }}
                >
                  {SEAT_FILL_LABEL[fill]}
                </button>
              ))
            )}
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', marginBottom: 4, opacity: 0.85, fontSize: 13 }}>Your colour</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SELECTABLE_COLORS.map(c => (
            <button key={c} onClick={() => setHumanColor(c)}
              style={{ ...mini, textTransform: 'capitalize',
                ...(humanColor === c ? { background: '#5a3380', color: 'white' } : {}) }}>
              {c}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 4, fontSize: 11, opacity: 0.55 }}>
          The other seats take the classic colours in order.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', marginBottom: 4, opacity: 0.85, fontSize: 13 }}>
          Market half-decks (pick 2)
          <span style={{ opacity: 0.5, fontSize: 11 }}> · {halfDecks.length}/2 selected</span>
        </label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {HALF_DECKS.filter(d => !EXPANSION_HALF_DECKS.has(d)).map(d => {
            const idx = halfDecks.indexOf(d);
            return (
              <button key={d} onClick={() => toggleDeck(d)}
                style={{ ...mini, ...(idx >= 0 ? { background: '#5a3380', color: 'white' } : {}) }}>
                {d}{idx >= 0 && <span style={{ marginLeft: 6, opacity: 0.7 }}>#{idx + 1}</span>}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, opacity: 0.55, margin: '8px 0 4px' }}>
          Aberrations &amp; Undead expansion:
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {HALF_DECKS.filter(d => EXPANSION_HALF_DECKS.has(d)).map(d => {
            const idx = halfDecks.indexOf(d);
            return (
              <button key={d} onClick={() => toggleDeck(d)}
                title="From the Aberrations & Undead expansion. Card-effect mechanics are still being wired in — some cards' special effects may be no-ops until that's complete."
                style={{ ...mini, border: '1px dashed #6a4595',
                  ...(idx >= 0 ? { background: '#5a3380', color: 'white' } : {}) }}>
                {d}{idx >= 0 && <span style={{ marginLeft: 6, opacity: 0.7 }}>#{idx + 1}</span>}
              </button>
            );
          })}
        </div>
        <button onClick={randomizeDecks} style={mini}>Random 2</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={onCreate} disabled={busy || halfDecks.length !== 2} style={btn}>
          {busy
            ? 'Creating…'
            : botCount === 0
              ? `New ${numPlayers}-player game`
              : `New game · ${humanCount}H + ${botCount}AI`}
        </button>
      </div>
      <p style={{ color: '#778', fontSize: 12 }}>
        Bots take their turns on the server, so a table never stalls waiting on
        an empty seat. Mixed games still count on the leaderboard — sign in
        first so your result is recorded.
      </p>
      {err && <p style={{ color: '#f66' }}>{err}</p>}

      {game && (
        <div style={{ marginTop: 24 }}>
          <p>
            Game <code>{game.gameId}</code> created.{' '}
            {createdBots.length > 0
              ? `Seats ${createdBots.map((sd) => `${sd} (${COLOR_NAMES[Number(sd)]})`).join(', ')} are bots — send a link to each of the others:`
              : 'Share one link per seat:'}
          </p>
          {(Object.keys(game.invites) as PlayerId[])
            .filter((seat) => !createdBots.includes(seat))
            .map((seat) => (
              <InviteRow key={seat} seat={seat} url={game.invites[seat]} />
            ))}
        </div>
      )}

      <GamesInProgress reloadKey={reloadKey} />

      <div style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 18 }}>Leaderboard</h2>
        <p style={{ color: '#778', fontSize: 12, marginTop: -4 }}>
          Per-game ratings (Glicko-2). Anon players are provisional (*); sign in
          to make your rating permanent and carry it across devices. ·{' '}
          <a href={`${HUB_URL}/leaderboard?game=tyrants`} target="_blank" rel="noopener"
             style={{ color: '#6cf' }}>open full page ↗</a>
        </p>
        <TyrantsLeaderboard />
      </div>

      <MoreGames />
    </div>
  );
}

function TyrantsLeaderboard() {
  const { identity } = useIdentity();
  return <Leaderboard game="tyrants" highlightPlayerId={identity?.playerId} />;
}

/** The cross-game hub's canonical URL. Its games.json is the single source of
 *  truth (served CORS-open), so adding a game there makes it appear here with
 *  no change to this file. */
const HUB_URL = 'https://games-hub-5vo.pages.dev';

interface HubGame {
  id: string;
  name: string;
  blurb?: string;
  url: string | null;
  status: string;
  accent?: string;
}

/** "More board games" — the other games from the hub, fetched live. Filters out
 *  Tyrants itself; hides entirely if the hub is unreachable (never breaks the
 *  lobby). */
function MoreGames() {
  const [games, setGames] = useState<HubGame[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${HUB_URL}/games.json`, { cache: 'no-cache' })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setGames(((d?.games ?? []) as HubGame[]).filter((g) => g.id !== 'tyrants'));
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed || (games && games.length === 0)) return null;

  return (
    <div style={{ marginTop: 36 }}>
      <h2 style={{ fontSize: 18 }}>More board games</h2>
      <p style={{ color: '#778', fontSize: 12, marginTop: -4 }}>
        Other games by the same author — <a href={HUB_URL} style={{ color: '#6cf' }}>see all →</a>
      </p>
      {!games && <p style={{ color: '#778' }}>Loading…</p>}
      {games?.map((g) => {
        const playable = g.status !== 'soon' && !!g.url;
        const inner = (
          <>
            <strong style={{ color: playable ? '#cbd' : '#889' }}>{g.name}</strong>
            {g.status === 'soon' && <span style={{ color: '#778', fontSize: 12 }}> (coming soon)</span>}
            {g.blurb && <div style={{ color: '#889', fontSize: 12 }}>{g.blurb}</div>}
          </>
        );
        const frame: React.CSSProperties = {
          display: 'block', margin: '10px 0', paddingLeft: 10,
          borderLeft: `3px solid ${g.accent ?? '#5a3380'}`,
        };
        return playable ? (
          <a key={g.id} href={g.url!} style={{ ...frame, textDecoration: 'none' }}>{inner}</a>
        ) : (
          <div key={g.id} style={{ ...frame, opacity: 0.6 }}>{inner}</div>
        );
      })}
    </div>
  );
}

function seatLabel(seat: PlayerId): string {
  const i = Number(seat);
  return `Seat ${seat} (${COLOR_NAMES[i] ?? seat})`;
}

function GamesInProgress({ reloadKey }: { reloadKey: number }) {
  const [games, setGames] = useState<MyGame[]>([]);
  const [status, setStatus] = useState<Record<string, string>>({});

  function load() {
    const gs = listMyGames();
    setGames(gs);
    gs.forEach(async (g) => {
      const seat = Object.keys(g.seats)[0] as PlayerId | undefined;
      const token = seat ? g.seats[seat] : undefined;
      if (!token) return;
      try {
        const st = await fetchStatus(g.gameId, token);
        const label = st.deleted ? 'ended'
          : st.gameOver ? 'finished'
          : st.yourTurn ? 'seat 0: your turn'
          : 'waiting';
        setStatus((prev) => ({ ...prev, [g.gameId]: label }));
      } catch {
        setStatus((prev) => ({ ...prev, [g.gameId]: 'unavailable' }));
      }
    });
  }

  useEffect(load, [reloadKey]);

  if (games.length === 0) return null;

  return (
    <div style={{ marginTop: 36 }}>
      <h2 style={{ fontSize: 18 }}>Games in progress</h2>
      <p style={{ color: '#778', fontSize: 12, marginTop: -4 }}>
        Remembered on this device only — clearing browser data forgets them.
      </p>
      {games.map((g) => (
        <div
          key={g.gameId}
          style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}
        >
          <code style={{ minWidth: 90 }}>{g.gameId.slice(0, 8)}…</code>
          <span style={{ color: '#aab', minWidth: 130 }}>{status[g.gameId] ?? 'loading…'}</span>
          {(Object.keys(g.seats) as PlayerId[]).map((seat) => (
            <a key={seat} href={`/play/${g.gameId}?as=${g.seats[seat]}`} style={{ color: '#6cf' }}>
              Resume {seatLabel(seat)}
            </a>
          ))}
          <button style={mini} onClick={() => { forgetGame(g.gameId); load(); }}>
            Remove
          </button>
          <button
            style={{ ...mini, color: '#f88' }}
            onClick={async () => {
              const seat = Object.keys(g.seats)[0] as PlayerId | undefined;
              const token = seat ? g.seats[seat] : undefined;
              if (token && confirm('End this game for all players? This deletes it.')) {
                try { await deleteGame(g.gameId, token); } catch { /* already gone */ }
              }
              forgetGame(g.gameId);
              load();
            }}
          >
            End
          </button>
        </div>
      ))}
    </div>
  );
}

function InviteRow({ seat, url }: { seat: PlayerId; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
      <strong style={{ width: 140 }}>{seatLabel(seat)}</strong>
      <a href={url} style={{ color: '#6cf', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {url}
      </a>
      <button
        style={{ ...btn, padding: '4px 10px' }}
        onClick={() => {
          navigator.clipboard?.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: '#5a3380',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 15,
  cursor: 'pointer',
};

const mini: React.CSSProperties = {
  background: 'transparent',
  color: '#aab',
  border: '1px solid #445',
  borderRadius: 4,
  padding: '3px 10px',
  fontSize: 13,
  cursor: 'pointer',
};
