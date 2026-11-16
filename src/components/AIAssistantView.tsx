import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { AppLanguage, DocumentRecord } from '../types';
import { getT } from '../i18n/translations';
import { extractDocumentPagesText, renderPageToDataUrl } from '../services/pdfEngine';
import { getApiUrl } from '../services/apiConfig';
import { PdfSourcePicker } from './PdfSourcePicker';

interface AIAssistantViewProps {
  language: AppLanguage;
  docs: DocumentRecord[];
  initialDocId?: string;
  aiConsentGranted: boolean;
  localOnlyMode: boolean;
  onImportDoc?: (doc: DocumentRecord) => Promise<void>;
  onGrantConsent: () => void;
  onDisableLocalOnly?: () => void;
  onClose: () => void;
}

interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
}

export const AIAssistantView: React.FC<AIAssistantViewProps> = ({
  language,
  docs,
  initialDocId,
  aiConsentGranted,
  localOnlyMode,
  onImportDoc,
  onGrantConsent,
  onDisableLocalOnly,
  onClose,
}) => {
  const t = getT(language);
  const available = docs.filter((d) => !d.isTrashed && !d.isVaultLocked);
  const recentFirst = [...available].sort(
    (a, b) => (b.lastOpenedAt || b.updatedAt) - (a.lastOpenedAt || a.updatedAt)
  );
  const [selectedDocId, setSelectedDocId] = useState(
    initialDocId || recentFirst[0]?.id || ''
  );
  const [showDocPicker, setShowDocPicker] = useState<boolean>(!initialDocId && !recentFirst[0]);
  const [pages, setPages] = useState<Array<{ pageNumber: number; text: string }>>([]);
  const [extracting, setExtracting] = useState(false);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const selectedDoc = available.find((d) => d.id === selectedDocId);
  const activeDocIdRef = useRef(selectedDocId);
  activeDocIdRef.current = selectedDocId;
  const extractPromiseRef = useRef<Promise<Array<{ pageNumber: number; text: string }>> | null>(null);

  useEffect(() => {
    if (!selectedDoc) {
      setPages([]);
      extractPromiseRef.current = null;
      return;
    }
    const targetId = selectedDoc.id;
    let cancelled = false;
    setExtracting(true);
    const p = extractDocumentPagesText(selectedDoc.pdfBytes)
      .then((res) => {
        if (!cancelled && activeDocIdRef.current === targetId) {
          setPages(res);
        }
        return res;
      })
      .catch(() => {
        if (!cancelled && activeDocIdRef.current === targetId) {
          setPages([]);
        }
        return [] as Array<{ pageNumber: number; text: string }>;
      })
      .finally(() => {
        if (!cancelled && activeDocIdRef.current === targetId) {
          setExtracting(false);
        }
      });
    extractPromiseRef.current = p;
    return () => {
      cancelled = true;
    };
  }, [selectedDocId, selectedDoc?.pdfBytes]);

  const sendRequest = async (mode: string, customPrompt?: string) => {
    if (!selectedDoc || loading || !aiConsentGranted || localOnlyMode) return;
    const promptText = customPrompt ?? input.trim();
    if (!promptText && mode === 'qa') return;

    const userDisplay =
      customPrompt ||
      (mode !== 'qa'
        ? t.ai.quickPrompts[mode as keyof typeof t.ai.quickPrompts] || mode
        : promptText);

    const nextMessages: ChatItem[] = [
      ...messages,
      { id: `u_${Date.now()}`, role: 'user', content: userDisplay },
    ];
    setMessages(nextMessages);
    if (!customPrompt) setInput('');
    setLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      let currentPages = pages;
      if (extractPromiseRef.current && (extracting || currentPages.length === 0)) {
        currentPages = await extractPromiseRef.current;
      }

      const extractedChars = currentPages.reduce((acc, p) => acc + p.text.trim().length, 0);
      const pageImages: Array<{ pageNumber: number; base64: string; mimeType: string }> = [];

      // If scanned / image-only PDF with little or no embedded text, render pages visually for Gemini Vision
      if (extractedChars < 25) {
        const previewCount = Math.min(4, Math.max(1, selectedDoc.pageCount || 1));
        for (let pageIdx = 1; pageIdx <= previewCount; pageIdx++) {
          const dataUrl = await renderPageToDataUrl(
            selectedDoc.pdfBytes,
            pageIdx,
            1.25,
            'image/jpeg'
          ).catch(() => '');
          if (dataUrl) {
            pageImages.push({
              pageNumber: pageIdx,
              base64: dataUrl,
              mimeType: 'image/jpeg',
            });
          }
        }
      }

      const res = await fetch(getApiUrl('/api/ai/assistant'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          documentTitle: selectedDoc.name,
          pages: currentPages,
          pageImages,
          prompt: promptText,
          mode,
          language,
          history: messages
            .filter((m) => m.role !== 'error')
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const rawText = await res.text();
      let data: { text?: string; error?: string } = {};
      try {
        data = rawText ? (JSON.parse(rawText) as { text?: string; error?: string }) : {};
      } catch {
        if (!res.ok) {
          throw new Error(`AI service error (HTTP ${res.status})`);
        }
      }

      if (!res.ok) {
        throw new Error(data.error || `AI Assistant request failed (${res.status})`);
      }
      setMessages((prev) => [
        ...prev,
        { id: `a_${Date.now()}`, role: 'assistant', content: data.text || '(Empty response)' },
      ]);
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'Request timed out. Please try again.'
          : err instanceof Error
          ? err.message
          : 'Unable to reach AI Assistant';
      setMessages((prev) => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          role: 'error',
          content: msg,
        },
      ]);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  const quickActions = [
    { id: 'summarize', label: t.ai.quickPrompts.summarize },
    { id: 'keypoints', label: t.ai.quickPrompts.keypoints },
    { id: 'outline', label: t.ai.quickPrompts.outline },
    { id: 'explain', label: t.ai.quickPrompts.explain },
    { id: 'tables', label: t.ai.quickPrompts.tables },
    { id: 'translate_bn', label: t.ai.quickPrompts.translate_bn },
    { id: 'translate_en', label: t.ai.quickPrompts.translate_en },
    { id: 'report', label: t.ai.quickPrompts.report },
  ];

  const totalExtractedChars = pages.reduce((acc, p) => acc + p.text.length, 0);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#F8FAFC] dark:bg-[#0B1120]">
      <header className="flex items-center justify-between px-3 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="font-display text-sm font-bold text-[#142B4A] dark:text-white flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-[#2563EB]" />
              {t.ai.title}
            </h1>
            <p className="text-[11px] text-slate-500">Page-cited English &amp; বাংলা analysis</p>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            aria-label="Clear chat"
            className="min-h-[40px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        )}
      </header>

      {localOnlyMode ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-sm rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 text-center space-y-3 shadow-lg">
            <ShieldCheck className="w-10 h-10 text-[#2563EB] mx-auto" />
            <h2 className="font-display text-base font-bold">Strict Local-Only Mode Active</h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Strict Local-Only Mode blocks external AI requests. Disable it below or in Settings to use AI Assistant.
            </p>
            {onDisableLocalOnly && (
              <button
                onClick={onDisableLocalOnly}
                className="w-full min-h-[44px] rounded-xl bg-[#2563EB] text-white font-semibold text-xs"
              >
                Enable AI Requests (Turn Off Local-Only)
              </button>
            )}
          </div>
        </div>
      ) : !aiConsentGranted ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-lg">
            <div className="w-12 h-12 rounded-2xl bg-[#2563EB]/10 text-[#2563EB] flex items-center justify-center">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <h2 className="font-display text-lg font-bold text-[#142B4A] dark:text-white">
              {t.ai.consentTitle}
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {t.ai.consentBody}
            </p>
            <button
              onClick={onGrantConsent}
              className="w-full min-h-[48px] rounded-xl bg-[#2563EB] text-white font-semibold text-sm"
            >
              {t.ai.consentAllow}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Document Selector & Quick Actions */}
          <div className="px-3 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 space-y-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowDocPicker((v) => !v)}
              className="w-full min-h-[42px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex items-center justify-between gap-2 text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-[#2563EB] shrink-0" />
                <span className="text-xs font-semibold truncate">
                  {selectedDoc
                    ? `${selectedDoc.name} (${selectedDoc.pageCount}p)`
                    : language === 'bn'
                    ? 'ডিভাইস বা রিসেন্ট থেকে পিডিএফ বাছুন'
                    : 'Choose PDF from Device or Recent'}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] font-mono-nums text-slate-500">
                  {extracting ? '...' : `${totalExtractedChars} chars`}
                </span>
                {showDocPicker ? (
                  <ChevronUp className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </div>
            </button>

            {showDocPicker && (
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                <PdfSourcePicker
                  language={language}
                  docs={docs}
                  selectedDocId={selectedDocId}
                  compact
                  maxListHeightClass="max-h-40"
                  onImportDoc={onImportDoc}
                  onSelectDoc={(d) => {
                    setSelectedDocId(d.id);
                    setMessages([]);
                    setShowDocPicker(false);
                  }}
                />
              </div>
            )}

            {!extracting && selectedDoc && totalExtractedChars === 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Scanned PDF detected — AI Assistant will read page images directly (up to 4 pages). Run OCR for full multi-page indexing.
              </p>
            )}

            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {quickActions.map((qa) => (
                <button
                  key={qa.id}
                  onClick={() => sendRequest(qa.id)}
                  disabled={loading || !selectedDoc}
                  className="min-h-[38px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-[#2563EB] hover:text-white text-xs font-semibold whitespace-nowrap shrink-0 transition-colors disabled:opacity-40"
                >
                  {qa.label}
                </button>
              ))}
            </div>
          </div>

          {/* Conversation Thread */}
          <div className="flex-1 overflow-y-auto p-4 max-w-3xl w-full mx-auto space-y-3">
            {messages.length === 0 ? (
              <div className="py-12 text-center space-y-2">
                <Sparkles className="w-8 h-8 text-[#2563EB] mx-auto" />
                <p className="font-display text-base font-bold text-[#142B4A] dark:text-white">
                  Ask anything about {selectedDoc?.name || 'your PDF'}
                </p>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  Tap a quick action above or ask questions in English or বাংলা. Answers include exact [Page X] citations.
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                      m.role === 'user'
                        ? 'bg-[#2563EB] text-white'
                        : m.role === 'error'
                        ? 'bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-200'
                        : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100 shadow-sm'
                    }`}
                  >
                    <div>{m.content}</div>
                    {m.role === 'assistant' && (
                      <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                        <button
                          onClick={() => {
                            navigator.clipboard?.writeText(m.content);
                            setCopiedId(m.id);
                            setTimeout(() => setCopiedId(null), 1600);
                          }}
                          className="text-[11px] font-semibold text-slate-500 hover:text-[#2563EB] flex items-center gap-1"
                        >
                          {copiedId === m.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-500" /> Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" /> Copy
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-500 animate-pulse">
                  Analyzing document pages...
                </div>
              </div>
            )}
          </div>

          {/* Prompt Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendRequest('qa');
            }}
            className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 p-3 pb-safe shrink-0"
          >
            <div className="max-w-3xl mx-auto flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t.ai.askPlaceholder}
                className="flex-1 min-h-[46px] px-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
              />
              <button
                type="submit"
                disabled={loading || !input.trim() || !selectedDoc}
                aria-label="Send"
                className="min-h-[46px] min-w-[46px] rounded-2xl bg-[#2563EB] disabled:opacity-40 text-white flex items-center justify-center shrink-0"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
};
