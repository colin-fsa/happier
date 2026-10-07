/**
 * How a spinner moves right now.
 *
 * - `animate`: the chosen style plays.
 * - `still`: the full chosen mark held at rest. A paused spinner still says "this is the running state".
 * - `breathe`: reduced motion. No light travels; the still chosen mark fades gently in and out as one piece.
 */
export type DotSpinnerMotion = 'animate' | 'still' | 'breathe';

export function resolveSpinnerMotion(params: Readonly<{ paused: boolean; reduceMotion: boolean }>): DotSpinnerMotion {
    if (params.paused) return 'still';
    return params.reduceMotion ? 'breathe' : 'animate';
}
