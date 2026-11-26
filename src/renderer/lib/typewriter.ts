import { useEffect, useRef, useState } from 'react';

/**
 * Streaming text does not arrive character by character: the endpoint pushes a
 * burst of a few to a few dozen characters every few dozen milliseconds, and
 * painting each burst the moment it lands reads as a stutter — one blob, pause,
 * next blob — not as a sentence being written.
 *
 * This eases the gap shut. The data still arrives in bursts; the reveal runs at
 * frame rate and spreads whatever backlog exists over a handful of frames, so a
 * burst lands within ~100ms but as a ribbon instead of a jump. Once the reader is
 * caught up, each frame adds a character or two, which is the typewriter.
 *
 * `animate` false (a finished reply, a reopened thread) shows the text whole.
 */

/** Frames a backlog is spread over: lower is snappier, higher is silkier. */
const CATCH_UP = 6;
/** A backlog this large is not a burst — a hidden window, or a thread switch. */
const SNAP_BACKLOG = 480;
/** Long replies re-parse a lot of Markdown per frame; give them every other frame. */
const PATIENT_LENGTH = 2400;

interface RevealState {
  shown: number;
  target: number;
  animate: boolean;
  raf: number;
  skip: number;
}

export function useTypewriter(text: string, animate: boolean): string {
  // A paragraph that already has text when it mounts is a resumed turn, not a
  // fresh delta: start near its end instead of typing history back out.
  const [shown, setShown] = useState(() => (animate ? Math.max(0, text.length - 24) : text.length));
  const state = useRef<RevealState>({ shown, target: text.length, animate, raf: 0, skip: 0 });
  state.current.shown = shown;
  state.current.target = text.length;
  state.current.animate = animate;

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const tick = (): void => {
      state.current.raf = 0;
      const { target, shown: current, animate: on, skip } = state.current;
      // A finished reply, a hidden window, or an accessibility preference: no
      // reason to type, and no reason to leave the text half-said.
      if (!on || motion.matches || target - current > SNAP_BACKLOG) {
        if (current !== target) setShown(target);
        return;
      }
      if (current >= target) return;
      if (target > PATIENT_LENGTH && skip % 2 === 1) {
        state.current.skip = skip + 1;
        state.current.raf = requestAnimationFrame(tick);
        return;
      }
      state.current.skip = skip + 1;
      const step = Math.max(1, Math.ceil((target - current) / CATCH_UP));
      setShown(Math.min(target, current + step));
      if (current + step < target) state.current.raf = requestAnimationFrame(tick);
    };

    if (state.current.raf !== 0) return;
    if (!animate) {
      if (state.current.shown !== text.length) setShown(text.length);
      return;
    }
    if (state.current.shown >= text.length) return;
    state.current.raf = requestAnimationFrame(tick);
    return () => {
      if (state.current.raf !== 0) cancelAnimationFrame(state.current.raf);
      state.current.raf = 0;
    };
  }, [text, animate]);

  return shown >= text.length ? text : text.slice(0, shown);
}
