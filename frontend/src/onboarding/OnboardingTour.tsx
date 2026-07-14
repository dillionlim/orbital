'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { TOUR_STEPS, type TourStep } from './steps';

const CARD_W = 360;      // tooltip width; also the clamp width when positioning
const GAP = 14;          // space between the spotlight and the tooltip
const PAD = 8;           // spotlight padding around the target
const MARGIN = 12;       // min distance from the viewport edge

interface Pos { top: number; left: number }

function place(rect: DOMRect, card: { w: number; h: number }, want: TourStep['placement']): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const room = {
    top: rect.top,
    bottom: vh - rect.bottom,
    left: rect.left,
    right: vw - rect.right,
  };
  const needed = { top: card.h + GAP, bottom: card.h + GAP, left: card.w + GAP, right: card.w + GAP };

  const order: Array<NonNullable<TourStep['placement']>> = [
    want ?? 'bottom',
    'bottom',
    'top',
    'right',
    'left',
  ];
  const side =
    order.find((s) => room[s] >= needed[s] + MARGIN) ??
    (Object.keys(room) as Array<NonNullable<TourStep['placement']>>).sort(
      (a, b) => room[b] - needed[b] - (room[a] - needed[a]),
    )[0];

  let top: number;
  let left: number;
  if (side === 'top' || side === 'bottom') {
    top = side === 'top' ? rect.top - card.h - GAP : rect.bottom + GAP;
    left = rect.left + rect.width / 2 - card.w / 2;
  } else {
    left = side === 'left' ? rect.left - card.w - GAP : rect.right + GAP;
    top = rect.top + rect.height / 2 - card.h / 2;
  }

  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  return {
    top: clamp(top, MARGIN, Math.max(MARGIN, vh - card.h - MARGIN)),
    left: clamp(left, MARGIN, Math.max(MARGIN, vw - card.w - MARGIN)),
  };
}

export const OnboardingTour: React.FC<{ onFinish: () => void }> = ({ onFinish }) => {
  const [steps] = useState<TourStep[]>(() =>
    typeof document === 'undefined'
      ? TOUR_STEPS
      : TOUR_STEPS.filter((s) => !s.target || !!document.querySelector(s.target)),
  );
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const step = steps[i];
  const isLast = i === steps.length - 1;
  const targetRect = step?.target ? rect : null;

  const next = useCallback(() => {
    if (isLast) onFinish();
    else setI((v) => v + 1);
  }, [isLast, onFinish]);
  const back = useCallback(() => setI((v) => Math.max(0, v - 1)), []);

  useEffect(() => {
    if (!step?.target) return;
    const el = document.querySelector(step.target);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    let frame = 0;
    let stable = 0;
    let last = '';
    const measure = () => {
      const r = el.getBoundingClientRect();
      const sig = `${r.top}|${r.left}|${r.width}|${r.height}`;
      if (sig === last) stable += 1;
      else {
        stable = 0;
        last = sig;
        setRect(r);
      }
      if (stable < 10) frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);

    const sync = () => setRect(el.getBoundingClientRect());
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [step]);

  useLayoutEffect(() => {
    if (!targetRect || !cardRef.current) return;
    setPos(place(targetRect, { w: CARD_W, h: cardRef.current.offsetHeight }, step?.placement));
  }, [targetRect, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFinish();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, onFinish]);

  if (!step) return null;

  const centred = !targetRect;

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Product tour">
      <div
        className={`absolute inset-0 ${centred ? 'bg-slate-950/80 backdrop-blur-[2px]' : ''}`}
        onClick={onFinish}
      />

      {targetRect && (
        <div
          className="absolute rounded-lg ring-2 ring-blue-500 pointer-events-none transition-all duration-200"
          style={{
            top: targetRect.top - PAD,
            left: targetRect.left - PAD,
            width: targetRect.width + PAD * 2,
            height: targetRect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.78)',
          }}
        />
      )}

      <div
        ref={cardRef}
        className={`absolute bg-slate-800 border border-slate-700 rounded-lg shadow-2xl p-5 ${
          centred ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : ''
        } ${!centred && !pos ? 'opacity-0' : 'opacity-100'}`}
        style={
          centred
            ? { width: CARD_W }
            : { width: CARD_W, top: pos?.top ?? 0, left: pos?.left ?? 0 }
        }
      >
        <button
          type="button"
          onClick={onFinish}
          className="absolute top-3 right-3 p-1 rounded text-slate-500 hover:text-white hover:bg-slate-700 transition-colors"
          title="Skip tour"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="text-[10px] uppercase tracking-wide text-blue-400 font-bold mb-1">
          Step {i + 1} of {steps.length}
        </div>
        <h3 className="font-semibold text-white text-lg pr-6">{step.title}</h3>
        <p className="mt-2 text-sm text-slate-300 leading-relaxed">{step.body}</p>

        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {steps.map((s, idx) => (
              <span
                key={s.id}
                className={`h-1.5 rounded-full transition-all ${
                  idx === i ? 'w-4 bg-blue-500' : 'w-1.5 bg-slate-600'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {i > 0 && (
              <button
                type="button"
                onClick={back}
                className="flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {isLast ? 'Get started' : 'Next'}
              {!isLast && <ArrowRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {!isLast && (
          <button
            type="button"
            onClick={onFinish}
            className="mt-3 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Skip the tour
          </button>
        )}
      </div>
    </div>
  );
};
