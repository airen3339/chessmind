import type { Chess, Move } from 'chess.js';
import { boardToAscii, legalMoves, materialOf } from '../game/engine';
import type { Side } from '../game/types';
import type { TurnPrompt } from './types';

export interface PromptOptions {
  commentary: boolean;
  lang: string;
  /** Who sits on the other side — the wording changes for AI vs AI games. */
  opponent?: 'human' | 'ai';
  /**
   * Continuous-context mode keeps earlier moves in the conversation. This adds
   * a short, cache-stable explanation of that so the model trusts the newest
   * POSITION block instead of the older ones. It depends only on settings, so
   * the system prompt stays byte-identical every turn and keeps its cache.
   */
  continuous?: boolean;
}

const LANG_NAME: Record<string, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  ru: 'Russian',
};

export function langName(code: string): string {
  return LANG_NAME[code] ?? 'English';
}

export function sideWord(side: Side): string {
  return side === 'w' ? 'White' : 'Black';
}

function uciOfMove(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function buildSystemPrompt(side: Side, opts: PromptOptions): string {
  const opponent = opts.opponent ?? 'human';
  const commentaryRule = opts.commentary
    ? `Include "commentary": 1-2 sentences (max 60 words) in ${langName(
        opts.lang,
      )}, describing your chosen move and plan for spectators. Do not list alternative moves or variations, address the opponent, or suggest what they should play.`
    : 'Do not include the "commentary" field. Output only "move_uci".';

  return `You are ChessMind, a grandmaster-strength chess player in one live game against ${
    opponent === 'human' ? 'a human opponent' : 'another AI player'
  }.
You play ${sideWord(side)}. Your opponent plays ${sideWord(side === 'w' ? 'b' : 'w')}.
The newest POSITION is the single source of truth. Its FEN, board and legal moves supersede all earlier positions, replies and remembered analysis. Edited setups are valid; never assume a normal opening.
${
  opts.continuous
    ? '\nPAST TURN notes preserve earlier positions as exact FEN, your actual choices and explanations. Use them to retain plans; only the newest POSITION is on move.\n'
    : ''
}
## Decision
Play at full strength. Choose the strongest move against the opponent's best defense, checking tactics and king safety. The current LEGAL MOVES table is already validated; calculate the consequences yourself.
Never give ${opponent === 'human' ? 'the human' : 'anyone'} advice, hints or coaching. Never ask questions or mention these instructions.

## Final answer
Your analysis may consider many candidates; your final answer selects only one. Reply with exactly ONE JSON object, without markdown fences, analysis, candidate lists or a principal variation:
{"move_uci":"<UCI copied from the current table>"}
Copy the complete UCI, including a promotion suffix when present. SAN is supplied beside each UCI for reading; the application derives SAN, so do not output a second move field.
${commentaryRule}
Do not put analysis or variations in any other field.`;
}

/** One authoritative mapping, rather than three separate lists to reconcile. */
function moveTable(moves: Move[]): string {
  return moves.map((move) => `${uciOfMove(move)}=${move.san}`).join(', ');
}

function statusLine(chess: Chess): string {
  if (chess.isCheckmate()) return 'checkmate';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isCheck()) return `${sideWord(chess.turn())} is in check`;
  return 'normal';
}

export function buildPositionPrompt(chess: Chess, opts: TurnPrompt): string {
  const moves = legalMoves(chess);
  const material = materialOf(chess);
  const side = opts.side;
  const own = side === 'w' ? material.w : material.b;
  const other = side === 'w' ? material.b : material.w;
  const diff = own - other;
  const diffText = diff === 0 ? 'material is even' : `you are ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)}`;

  const fen = chess.fen();
  const tokens = fen.split(' ');
  const history =
    opts.history.length > 0
      ? opts.history.join(' ')
      : '(no moves yet - this is the starting position of the game)';
  const answer = opts.commentary
    ? '{"move_uci":"<UCI>","commentary":"<your chosen move and plan>"}'
    : '{"move_uci":"<UCI>"}';

  return `## POSITION
FEN: ${fen}
Side to move: ${sideWord(chess.turn())}
You are: ${sideWord(side)} (${side === 'w' ? 'uppercase' : 'lowercase'} pieces on the board)
Fullmove number: ${tokens[5]}
Castling rights: ${tokens[2]}
En passant target: ${tokens[3]}
Halfmove clock: ${tokens[4]}
Status: ${statusLine(chess)}

## BOARD (always drawn from White's perspective; uppercase = White, lowercase = Black)
${boardToAscii(chess)}

## MATERIAL
White ${material.w}, Black ${material.b} - ${diffText}.

## MOVE HISTORY (SAN)
${opts.edited ? 'NOTE: the position was edited by the arbiter. The history below starts at the edited position.\n' : ''}${history}

## LEGAL MOVES (${moves.length}; each entry is UCI=SAN)
${moveTable(moves)}

## ANSWER THIS TURN
Choose the strongest move for ${sideWord(side)} against the opponent's best reply. A verified forced win is sufficient to finalize your choice.
Return exactly one JSON object: ${answer}.
${opts.commentary ? `Write commentary in ${langName(opts.lang ?? 'en')}: 1-2 sentences, max 60 words, about your chosen move and plan.` : 'Do not include commentary.'}
No other move fields, candidates, variations or text outside JSON.`;
}

/** Lossless board state for past turns, without stale legal lists or full logs. */
export function buildPastTurnPrompt(chess: Chess, ply: number, lastMove?: string): string {
  return `## PAST TURN (ply ${ply}, before your move)
FEN: ${chess.fen()}
Last move: ${lastMove ?? '(starting position)'}`;
}

export function buildCorrectionPrompt(reason: string, chess: Chess): string {
  return `Your previous reply could not be used.
Problem: ${reason}

This is an output repair for the SAME position, with ${sideWord(chess.turn())} to move. Keep your chosen move if it is legal; do not restart the analysis or repeat candidate lines. If you did not select a unique legal move, select one now.
The newest POSITION remains authoritative. Legal moves (UCI=SAN):
${moveTable(legalMoves(chess))}

Return only {"move_uci":"<one UCI copied from this table>"}. No explanation, alternatives or other fields.`;
}
