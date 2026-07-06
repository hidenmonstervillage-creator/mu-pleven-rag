'use client';

import { useEffect, useState } from 'react';
import { AnatomyModelEntry, AnatomyTopic } from '@/lib/anatomy-catalog';
import { matchAnatomy, AnatomyMatch } from '@/lib/anatomy-match';

interface AnatomySuggestProps {
  question: string;
  questionNonce: number;
  onOpenTopic: (model: AnatomyModelEntry, topic: AnatomyTopic) => void;
}

// Chat-driven 3D suggestion. On each sent message, matches the text against the
// anatomy catalog (region/system synonyms + structure tokens, BG + Latin/English)
// and surfaces a subtle, dismissible chip. Not subject-gated — anatomical
// questions in ANY subject can surface it. Sits just above the slide suggestion.
export default function AnatomySuggest({ question, questionNonce, onOpenTopic }: AnatomySuggestProps) {
  const [matches, setMatches] = useState<AnatomyMatch[]>([]);

  useEffect(() => {
    if (!question.trim()) { setMatches([]); return; }
    setMatches(matchAnatomy(question));
  }, [questionNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  if (matches.length === 0) return null;

  return (
    <div className="fixed bottom-[150px] left-1/2 -translate-x-1/2 z-30 max-w-[92vw]">
      <div className="flex items-start gap-2 bg-white border border-slate-300 shadow-xl rounded-2xl pl-3.5 pr-2 py-2">
        <div className="flex flex-col gap-1">
          {matches.map((m) => (
            <button
              key={`${m.model.id}|${m.topic.id}`}
              onClick={() => { onOpenTopic(m.model, m.topic); setMatches([]); }}
              className="group flex items-center gap-1.5 text-sm text-slate-700 hover:underline text-left"
            >
              <span aria-hidden="true">🦴</span>
              <span>Виж в 3D: <span className="font-semibold">{m.label}</span></span>
              <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setMatches([])}
          className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          aria-label="Скрий предложението"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
