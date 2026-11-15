import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, Share, PlusSquare, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWA';

export const PWAInstallButton: React.FC<{ label?: string; compact?: boolean }> = ({
  label = 'Install App',
  compact = false,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className={`flex items-center justify-center gap-2 rounded-xl bg-[#2563EB] text-white font-semibold shadow-sm hover:bg-[#1D4ED8] active:scale-[0.98] transition-all whitespace-nowrap shrink-0 ${
          compact ? 'min-h-[44px] px-3.5 text-xs' : 'min-h-[48px] w-full px-4 text-sm'
        }`}
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>{label}</span>
      </button>
    );
  }

  if (compact && !isIOS) {
    return null;
  }

  const appUrl =
    typeof window !== 'undefined' && window.location.origin.startsWith('http')
      ? window.location.origin
      : 'https://ais-pre-34oy47d7syqws5h4yn7suw-60182063165.asia-northeast1.run.app';

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(appUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Ignore clipboard failures in restricted frames
    }
  };

  return (
    <>
      <button
        onClick={() => setShowGuide(true)}
        className={`flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[#142B4A] dark:text-slate-100 font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 ${
          compact ? 'min-h-[44px] px-3.5 text-xs' : 'min-h-[48px] w-full px-4 text-sm'
        }`}
      >
        <Smartphone className="w-4 h-4 shrink-0 text-[#2563EB]" />
        <span>{isIOS ? 'Install on iOS' : label}</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 p-6 shadow-2xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-lg font-bold text-[#142B4A] dark:text-white">
                {isIOS ? 'Install PDF MASTER on iOS' : 'Install PDF MASTER on Phone'}
              </h3>
              <button
                onClick={() => setShowGuide(false)}
                aria-label="Close"
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {isIOS ? (
              <ol className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
                <li className="flex items-center gap-3">
                  <Share className="w-5 h-5 text-[#2563EB] shrink-0" />
                  <span>
                    Tap the <strong>Share</strong> button in Safari&apos;s toolbar.
                  </span>
                </li>
                <li className="flex items-center gap-3">
                  <PlusSquare className="w-5 h-5 text-[#2563EB] shrink-0" />
                  <span>
                    Scroll down and tap <strong>Add to Home Screen</strong>.
                  </span>
                </li>
              </ol>
            ) : (
              <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
                <p className="text-xs leading-relaxed">
                  Install PDF MASTER directly onto your Android Home Screen with offline support — no APK compilation needed:
                </p>
                <ol className="space-y-2 text-xs list-decimal pl-4">
                  <li>
                    Open the app directly in <strong>Android Chrome</strong> (outside preview frames).
                  </li>
                  <li>
                    Tap the <strong>⋮ Menu</strong> in Chrome and choose{' '}
                    <strong>Install app</strong> or <strong>Add to Home screen</strong>.
                  </li>
                </ol>
                <div className="flex gap-2 pt-1">
                  <a
                    href={appUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-h-[42px] rounded-xl bg-[#2563EB] text-white text-xs font-semibold flex items-center justify-center"
                  >
                    Open in Browser
                  </a>
                  <button
                    onClick={handleCopyUrl}
                    className="min-h-[42px] px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-[#142B4A] dark:text-slate-200"
                  >
                    {copiedUrl ? 'Copied!' : 'Copy Link'}
                  </button>
                </div>
              </div>
            )}
            <button
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full min-h-[44px] rounded-xl bg-[#142B4A] dark:bg-slate-800 text-white text-sm font-semibold"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl bg-amber-600 text-white px-3.5 py-2 text-xs font-semibold shadow-lg">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span className="whitespace-nowrap">Offline Mode — Local PDF tools active</span>
    </div>
  );
};
