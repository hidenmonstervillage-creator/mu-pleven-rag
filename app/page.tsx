'use client';

import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import ChatArea from '@/components/ChatArea';
import MessageInput from '@/components/MessageInput';
import PDFViewer, { PDFViewerPayload } from '@/components/PDFViewer';
import SlidePanel from '@/components/SlidePanel';
import { ChatMessage, ConversationHistory, SourceChunk } from '@/lib/types';

// Persist conversation to localStorage
function saveConversation(conv: ConversationHistory) {
  const stored = localStorage.getItem('mup_conversations');
  const all: ConversationHistory[] = stored ? JSON.parse(stored) : [];
  const idx = all.findIndex((c) => c.id === conv.id);
  if (idx >= 0) {
    all[idx] = conv;
  } else {
    all.push(conv);
  }
  localStorage.setItem('mup_conversations', JSON.stringify(all));
}

// Derive a short conversation title from the first user message
function deriveTitle(message: string): string {
  return message.length > 50 ? message.slice(0, 50) + '...' : message;
}

export default function HomePage() {
  const [facultyId, setFacultyId] = useState('');
  const [specialtyId, setSpecialtyId] = useState('');
  const [subject, setSubject] = useState('');

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [pdfViewerPayload, setPdfViewerPayload] = useState<PDFViewerPayload | null>(null);
  const [askedQuestion, setAskedQuestion] = useState('');
  const [askNonce, setAskNonce] = useState(0);

  const handleOpenPdf = useCallback((payload: PDFViewerPayload) => {
    setPdfViewerPayload(payload);
  }, []);

  const startNewChat = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setInputValue('');
    setStreamingContent('');
  }, []);

  const loadConversation = useCallback((conv: ConversationHistory) => {
    setConversationId(conv.id);
    setMessages(conv.messages);
    setFacultyId(conv.facultyId);
    setSpecialtyId(conv.specialtyId);
    setSubject(conv.subject);
  }, []);

  const sendMessage = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isLoading) return;

    if (!facultyId || !specialtyId || !subject) {
      alert('Моля, изберете факултет, специалност и предмет преди да зададете въпрос.');
      return;
    }

    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInputValue('');
    setIsLoading(true);
    setStreamingContent('');

    // Feed the question to the slide auto-suggest (re-triggers on every send).
    setAskedQuestion(text);
    setAskNonce((n) => n + 1);

    // Prepare conversation history (without sources) for the API
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          facultyId,
          specialtyId,
          subject,
          conversationHistory: history,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error('API error');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let sources: SourceChunk[] = [];
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as { type: string; content?: string; sources?: SourceChunk[] };

          if (parsed.type === 'sources' && parsed.sources) {
            sources = parsed.sources;
          } else if (parsed.type === 'text' && parsed.content) {
            fullText += parsed.content;
            setStreamingContent(fullText);
          }
        }
      }

      const assistantMessage: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: fullText,
        sources,
        timestamp: Date.now(),
      };

      const finalMessages = [...updatedMessages, assistantMessage];
      setMessages(finalMessages);
      setStreamingContent('');

      // Persist to localStorage
      const convId = conversationId ?? uuidv4();
      if (!conversationId) setConversationId(convId);

      const conv: ConversationHistory = {
        id: convId,
        title: deriveTitle(text),
        messages: finalMessages,
        facultyId,
        specialtyId,
        subject,
        createdAt: finalMessages[0].timestamp,
        updatedAt: Date.now(),
      };
      saveConversation(conv);
    } catch (err) {
      console.error('Chat error:', err);
      const errorMessage: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: 'Възникна грешка при обработката на вашия въпрос. Моля, опитайте отново.',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
      setStreamingContent('');
    } finally {
      setIsLoading(false);
    }
  }, [inputValue, isLoading, facultyId, specialtyId, subject, messages, conversationId]);

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar
        currentConversationId={conversationId}
        onSelectConversation={loadConversation}
        onNewChat={startNewChat}
      />

      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar
          facultyId={facultyId}
          specialtyId={specialtyId}
          subject={subject}
          onFacultyChange={setFacultyId}
          onSpecialtyChange={setSpecialtyId}
          onSubjectChange={setSubject}
        />

        <ChatArea
          messages={messages}
          isLoading={isLoading}
          streamingContent={streamingContent}
          onOpenPdf={handleOpenPdf}
        />

        <MessageInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={sendMessage}
          disabled={isLoading}
          placeholder={
            subject
              ? `Задайте въпрос по ${subject}...`
              : 'Изберете предмет и задайте въпрос...'
          }
        />
      </div>

      <PDFViewer
        payload={pdfViewerPayload}
        onClose={() => setPdfViewerPayload(null)}
      />

      {/* Student-facing microscope-slide catalog — auto-hides for subjects with no slides */}
      <SlidePanel
        facultyId={facultyId}
        specialtyId={specialtyId}
        subject={subject}
        question={askedQuestion}
        questionNonce={askNonce}
      />
    </div>
  );
}
