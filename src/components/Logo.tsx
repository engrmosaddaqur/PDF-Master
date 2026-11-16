import React from 'react';

export const PdfMasterLogo: React.FC<{
  size?: number;
  showWordmark?: boolean;
  showTagline?: boolean;
  inverse?: boolean;
  tagline?: string;
}> = ({
  size = 36,
  showWordmark = true,
  showTagline = false,
  inverse = false,
  tagline = 'Everything PDF. One Powerful App.',
}) => {
  return (
    <div className="flex items-center gap-3 shrink-0">
      <img
        src="/app-icon.png"
        alt="PDF MASTER"
        width={size}
        height={size}
        className="shrink-0 rounded-2xl object-cover shadow-lg shadow-blue-500/25"
      />
      {showWordmark && (
        <div className="min-w-0">
          <div
            className={`font-display text-lg font-extrabold tracking-tight whitespace-nowrap leading-tight ${
              inverse ? 'text-white' : 'text-slate-900 dark:text-white'
            }`}
          >
            PDF <span className={inverse ? 'text-[#22D3EE]' : 'text-[#2563EB] dark:text-[#22D3EE]'}>MASTER</span>
          </div>
          {showTagline && (
            <div
              className={`text-xs truncate ${
                inverse ? 'text-blue-100/80' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {tagline}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
