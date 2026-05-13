'use client';

import { useState, useEffect } from 'react';
import { ConversationHistory } from '@/lib/types';

interface SidebarProps {
  currentConversationId: string | null;
  onSelectConversation: (conv: ConversationHistory) => void;
  onNewChat: () => void;
}

function groupByDate(conversations: ConversationHistory[]): Record<string, ConversationHistory[]> {
  const now = Date.now();
  const oneDay = 86400000;
  const groups: Record<string, ConversationHistory[]> = {};

  for (const conv of conversations) {
    const diff = now - conv.updatedAt;
    let label: string;
    if (diff < oneDay) label = 'Днес';
    else if (diff < 2 * oneDay) label = 'Вчера';
    else if (diff < 7 * oneDay) label = 'Тази седмица';
    else if (diff < 30 * oneDay) label = 'Този месец';
    else label = 'По-рано';

    if (!groups[label]) groups[label] = [];
    groups[label].push(conv);
  }

  return groups;
}

export default function Sidebar({ currentConversationId, onSelectConversation, onNewChat }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [conversations, setConversations] = useState<ConversationHistory[]>([]);

  useEffect(() => {
    const stored = localStorage.getItem('mup_conversations');
    if (stored) {
      const parsed: ConversationHistory[] = JSON.parse(stored);
      setConversations(parsed.sort((a, b) => b.updatedAt - a.updatedAt));
    }
  }, [currentConversationId]);

  const groups = groupByDate(conversations);
  const groupOrder = ['Днес', 'Вчера', 'Тази седмица', 'Този месец', 'По-рано'];

  if (collapsed) {
    return (
      <div className="flex flex-col items-center w-12 bg-[#FAFAFA] border-r border-[#E5E7EB] py-4 gap-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-lg hover:bg-gray-200 transition-colors"
          title="Отвори страничната лента"
        >
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          onClick={onNewChat}
          className="p-2 rounded-lg hover:bg-gray-200 transition-colors"
          title="Нов чат"
        >
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-64 bg-[#FAFAFA] border-r border-[#E5E7EB] flex-shrink-0 h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#E5E7EB]">
        <span className="text-sm font-semibold text-gray-700">История</span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1.5 rounded-lg hover:bg-gray-200 transition-colors"
        >
          <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="p-3">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2.5 bg-[#7B1C1C] text-white rounded-lg hover:bg-[#6a1818] transition-colors text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Нов чат
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {groupOrder.map((label) => {
          const group = groups[label];
          if (!group || group.length === 0) return null;
          return (
            <div key={label} className="mb-3">
              <p className="text-xs text-gray-400 font-medium px-2 py-1.5 uppercase tracking-wide">{label}</p>
              {group.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => onSelectConversation(conv)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate ${
                    conv.id === currentConversationId
                      ? 'bg-red-50 text-[#7B1C1C] font-medium'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {conv.title}
                </button>
              ))}
            </div>
          );
        })}
        {conversations.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8 px-4">
            Все още няма разговори. Започнете нов чат!
          </p>
        )}
      </div>
    </div>
  );
}
