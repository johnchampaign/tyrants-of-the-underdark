import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { BoardProps } from 'boardgame.io/react';
import { useGame, ChatPanel, useIdentity, SignInBar } from 'digital-boardgame-framework/client';
import { makeClient, makeMessagingClient, claimSeat } from './client';
import { rememberOpenedGame } from './myGames';
import { Board, BoardModeContext, type OnlineReportCategory } from '../App';
import { AI_VERSION } from '../ai-version';
import type { TyrantsState } from '../game';
import type { BgioState, TyrantsAction, PlayerId } from '../adapter/tyrantsAdapter';

// ONLINE play renders the REAL Tyrants board — the exact same <Board/> component
// hotseat uses — fed by a BoardProps-shaped object backed by the framework's
// useGame/submit instead of a boardgame.io Client.
//
// The seam (see App.tsx BoardModeContext):
//   - G / ctx     come straight from the redacted server view.
//   - playerID    is the server-assigned seat (`you`); Board reads it via
//                 BoardModeContext.mySeat and renders that seat's controls.
//   - isActive    is `yourTurn`.
//   - moves       is a PROXY: each bgio move name maps 1:1 onto a framework
//                 Action and is dispatched through submit(...). The 9 move names
//                 match the 9 TyrantsAction kinds exactly (see tyrantsAdapter).
//   - undo / redo / reset / loadState are no-ops online (hotseat-only rewind).
//   - isOnline=true gates off the local AI driver + all localStorage / archive /
//     publish side effects inside Board.
//
// A submit is fire-and-forget from the board's perspective (bgio moves return
// void); useGame re-fetches the authoritative view, which re-renders the board.

/** Build the moves proxy: bgio-move-name(...args) -> submit(Action). The arg
 *  shapes mirror toBgioAction in tyrantsAdapter.ts (the inverse mapping). */
function makeMovesProxy(
  submit: (a: TyrantsAction) => void,
): BoardProps<TyrantsState>['moves'] {
  const moves: Record<string, (...args: any[]) => void> = {
    deployStartingTroop: (siteId: string) => submit({ kind: 'deployStartingTroop', siteId }),
    playCard: (handIndex: number) => submit({ kind: 'playCard', handIndex }),
    recruitFromMarket: (marketIndex: number) => submit({ kind: 'recruitFromMarket', marketIndex }),
    recruitFromAuxStack: (stack: 'houseGuards' | 'priestesses') =>
      submit({ kind: 'recruitFromAuxStack', stack }),
    deployTroop: (spaceId: string) => submit({ kind: 'deployTroop', spaceId }),
    assassinateTroop: (spaceId: string) => submit({ kind: 'assassinateTroop', spaceId }),
    returnEnemySpy: (siteId: string, targetColor: string) =>
      submit({ kind: 'returnEnemySpy', siteId, targetColor: targetColor as any }),
    resolveChoice: (response: unknown) => submit({ kind: 'resolveChoice', response }),
    endTurn: () => submit({ kind: 'endTurn' }),
    // Hotseat-only rewind controls — no-ops online. Board disables/hides their
    // entry points when isOnline (undo button is gated on G.undoStack, which is
    // stripped by viewFor, so it's always disabled online anyway).
    undo: () => { /* online: server is authoritative; no client-side undo */ },
    redo: () => { /* online: no-op */ },
    loadState: () => { /* online: server is authoritative; no local snapshot load */ },
  };
  return moves as unknown as BoardProps<TyrantsState>['moves'];
}

export function OnlinePlay({ gameId, token }: { gameId: string; token: string }) {
  // Identity (anon or signed-in), kept in a ref so each move carries it to the
  // server — per-move attribution is robust + race-free (turns are sequential).
  const { identity } = useIdentity();
  const identityTokenRef = useRef<string | undefined>(undefined);
  identityTokenRef.current = identity?.token;

  const client = useMemo(
    () => makeClient(gameId, token, () => identityTokenRef.current),
    [gameId, token],
  );
  const messagingClient = useMemo(() => makeMessagingClient(gameId, token), [gameId, token]);
  const { view, yourTurn, gameOver, you, ranked, submit, loading, error } =
    useGame<BgioState, TyrantsAction>(client, {
      pollMs: 2000,
      trackLegalActions: false,
      // Match the submit budget. A poll isn't always a cheap read: if the AI
      // seat is mid-turn the server finishes that turn before answering, and
      // the default 20s backstop cut it off every time — the turn never
      // persisted and the board stayed frozen forever (#104).
      fetchTimeoutMs: 60_000,
    });

  useEffect(() => {
    if (you != null) rememberOpenedGame(gameId, you as PlayerId, token);
  }, [you, gameId, token]);

  // Also claim on load (covers a game where you never get a turn). Per-move
  // attribution above is the primary, more reliable path.
  useEffect(() => {
    if (identity?.token) void claimSeat(gameId, token, identity.token);
  }, [identity?.token, gameId, token]);

  // submit() returns a Promise; the board calls moves.x(...) synchronously and
  // ignores the result, so we fire-and-forget and let useGame re-fetch.
  //
  // PHANTOM "engine rejected" FIX: the same logical move could fire twice (rapid
  // click, a React re-invoke, or a submit racing useGame's poll). The first
  // applies server-side; the duplicate then hits a server that already advanced
  // and tryApplyAction rejects it — surfacing an "Illegal action" banner even
  // though the game moved on correctly. We guard two ways:
  //   1. SERIALIZE: only one submit is in flight at a time; the rest queue and
  //      apply in order. This keeps useGame's view/error consistent (no two
  //      submits interleaving their setState) and matches turn-based intent.
  //   2. DEDUPE identical actions: if an action with the *same* JSON payload is
  //      already in flight or sitting in the queue, drop the new one. Distinct
  //      moves a player makes in quick succession are NOT dropped (different
  //      payloads → different keys), so legitimate rapid play still works.
  // The keep-latest semantics aren't needed: every queued action is preserved
  // and applied in order; only exact duplicates are coalesced.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const queueRef = useRef<{ items: { key: string; action: TyrantsAction }[]; draining: boolean }>(
    { items: [], draining: false },
  );

  const enqueueSubmit = useCallback((a: TyrantsAction) => {
    const key = JSON.stringify(a);
    const q = queueRef.current;
    // Drop an exact-duplicate of something already pending/in-flight.
    if (q.items.some((it) => it.key === key)) return;
    q.items.push({ key, action: a });
    if (q.draining) return;
    q.draining = true;
    (async () => {
      while (q.items.length > 0) {
        const next = q.items[0]; // keep it in the queue so a duplicate is still detected
        try {
          // useGame.submit clears `error` on success and re-fetches the
          // authoritative view; a transient/stale error never lingers past the
          // next successful submit. On failure it re-syncs and rethrows — we
          // swallow the throw here (board ignores it) so the queue keeps draining.
          await submitRef.current(next.action);
        } catch {
          /* error surfaced via useGame.error; refresh already re-synced the view */
        } finally {
          q.items.shift();
        }
      }
      q.draining = false;
    })();
  }, []);

  const moves = useMemo(() => makeMovesProxy(enqueueSubmit), [enqueueSubmit]);

  // Online problem reports are a SINGLE write: client.report() -> server.report
  // -> framework store (durable snapshot). The server then forwards the stored
  // report to GitHub via the GitHubIssueForwarder (see functions/api +
  // vite.config), so the canonical triage channel is still GitHub Issues — but
  // the GitHub call now happens server-side, not here. We pass the game-defined
  // `category` (the server persists it and the forwarder maps 'multiplayer' ->
  // area:multiplayer) and the AI_VERSION build stamp for triage.
  const reportProblem = useMemo(
    () =>
      async (
        message: string,
        opts?: { category?: OnlineReportCategory },
      ): Promise<string> => {
        const r = await client.report({
          message,
          category: opts?.category ?? 'game',
          clientBuild: `tyrants-online@${AI_VERSION}`,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        });
        return r.reportId;
      },
    [client],
  );

  if (loading && !view) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!view) {
    return (
      <p style={{ padding: 24, color: '#f66' }}>
        Error: {error?.message ?? 'no view'} · <a href="/lobby" style={{ color: '#6cf' }}>← Lobby</a>
      </p>
    );
  }

  // Construct the BoardProps the real Board expects. Only the props Board
  // actually consumes need to be faithful: G, ctx, moves, plus the bgio-required
  // shape. The rest (events, log, matchData, etc.) are filled with safe stubs.
  const boardProps = {
    G: view.G,
    ctx: view.ctx as unknown as BoardProps<TyrantsState>['ctx'],
    moves,
    playerID: you ?? null,
    isActive: yourTurn,
    isMultiplayer: true,
    isConnected: true,
    events: {
      endTurn: () => {},
      endPhase: () => {},
      endStage: () => {},
      setPhase: () => {},
      setStage: () => {},
      endGame: () => {},
      setActivePlayers: () => {},
    } as unknown as BoardProps<TyrantsState>['events'],
    reset: () => {},
    undo: () => {},
    redo: () => {},
    log: [],
    matchID: gameId,
    matchData: undefined,
    sendChatMessage: () => {},
    chatMessages: [],
    plugins: (view as any).plugins ?? {},
  } as unknown as BoardProps<TyrantsState>;

  // Online games are seat-per-human (each seat joins via its own invite token;
  // there are no AI seats online), so the human-seat count is just the number
  // of seats. Chat only shows for 2+ humans — never in a solo/all-AI (hotseat)
  // game, which doesn't render OnlinePlay at all.
  const humanSeatCount = Object.keys(view.G.players).length;
  const labelForSeat = (seat: string) => {
    const color = view.G.players[seat]?.color;
    const name = color ? color.charAt(0).toUpperCase() + color.slice(1) : '';
    return color ? `${name} (P${Number(seat) + 1})` : `P${Number(seat) + 1}`;
  };

  return (
    <BoardModeContext.Provider value={{ isOnline: true, mySeat: (you ?? '0') as string, onlineError: error, reportProblem }}>
      {/* Invite-link joiners skip the lobby, so surface sign-in here too —
          signing in redirects back to this game URL and re-attributes the seat
          to the now-registered identity. Guests are still rated (provisional). */}
      <div style={{ padding: '0 12px' }}>
        <SignInBar leaderboardHref="https://games-hub-5vo.pages.dev/leaderboard?game=tyrants" />
        {gameOver && ranked && (
          <p style={{ margin: '0 0 8px', fontSize: 14, color: ranked.recorded ? '#6c6' : '#caa' }}>
            {ranked.recorded
              ? '✓ Recorded to the leaderboard.'
              : ranked.reason === 'one-player'
                ? 'Not ranked — both seats were the same player (you need two different people/identities).'
                : ranked.reason === 'no-identities'
                  ? 'Not ranked — no identities were attached to the seats.'
                  : "Not ranked — couldn't reach the leaderboard."}
          </p>
        )}
      </div>
      <Board {...boardProps} />
      {humanSeatCount >= 2 && (
        <ChatPanel client={messagingClient} you={(you ?? '0') as string} seatLabel={labelForSeat} />
      )}
    </BoardModeContext.Provider>
  );
}
