'use client';

import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChatMessage } from '@/lib/types';
import SourceCard from './SourceCard';
import { PDFViewerPayload } from './PDFViewer';
import Logo from './Logo';

interface ChatAreaProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingContent: string;
  onOpenPdf: (payload: PDFViewerPayload) => void;
}

function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-6 text-center">
      <Logo className="w-20 h-20 mb-5" />
      <h1 className="text-2xl font-bold text-[#7B1C1C] mb-2">МУ-Плевен AI Library</h1>
      <p className="text-gray-500 mb-10 max-w-md text-sm leading-relaxed">
        Изберете факултет, специалност и предмет от горното меню, след което задайте вашия академичен въпрос.
      </p>

      <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
        {[
          { icon: '📚', title: 'Учебници', desc: 'Търсене в пълен текст на качените учебници' },
          { icon: '🎓', title: 'Лекции', desc: 'Намиране на информация от лекционни слайдове' },
          { icon: '🔍', title: 'Семантично търсене', desc: 'Разбиране на въпроса, не само ключови думи' },
          { icon: '📄', title: 'Цитиране на източници', desc: 'Всеки отговор с посочена страница и материал' },
        ].map((card) => (
          <div
            key={card.title}
            className="flex flex-col gap-1.5 p-4 rounded-xl border border-[#E5E7EB] bg-white hover:shadow-sm transition-shadow"
          >
            <span className="text-2xl">{card.icon}</span>
            <span className="font-semibold text-gray-800 text-sm">{card.title}</span>
            <span className="text-gray-500 text-xs leading-snug">{card.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ChatArea({ messages, isLoading, streamingContent, onOpenPdf }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const showWelcome = messages.length === 0 && !isLoading;

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      {showWelcome ? (
        <WelcomeScreen />
      ) : (
        <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              {msg.role === 'user' ? (
                <div className="max-w-[80%] rounded-2xl bg-[#7B1C1C] text-white px-4 py-3 text-sm leading-relaxed">
                  {msg.content}
                </div>
              ) : (
                <div className="flex flex-col gap-3 w-full">
                  <div className="rounded-2xl bg-[#F9FAFB] border border-[#E5E7EB] px-5 py-4 text-sm text-gray-800 leading-relaxed prose prose-sm max-w-none">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                        Използвани източници
                      </p>
                      <div className="grid grid-cols-1 gap-2">
                        {msg.sources.map((src) => (
                          <SourceCard key={src.id} source={src} onOpen={onOpenPdf} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Streaming assistant message */}
          {isLoading && (
            <div className="flex flex-col items-start gap-3 w-full">
              {streamingContent ? (
                <div className="rounded-2xl bg-[#F9FAFB] border border-[#E5E7EB] px-5 py-4 text-sm text-gray-800 leading-relaxed prose prose-sm max-w-none w-full">
                  <ReactMarkdown>{streamingContent}</ReactMarkdown>
                  <span className="inline-block w-1.5 h-4 bg-[#7B1C1C] animate-pulse ml-0.5 align-middle" />
                </div>
              ) : (
                <div className="rounded-2xl bg-[#F9FAFB] border border-[#E5E7EB] px-5 py-4 flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-[#7B1C1C] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 bg-[#7B1C1C] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 bg-[#7B1C1C] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
