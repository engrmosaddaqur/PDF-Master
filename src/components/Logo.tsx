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
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 rounded-2xl shadow-lg shadow-blue-500/25"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="pmLogoBg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#3B82F6" />
            <stop offset="55%" stopColor="#2563EB" />
            <stop offset="100%" stopColor="#0EA5E9" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="url(#pmLogoBg)" />
        <path
          d="M19 14C19 12.3431 20.3431 11 22 11H37.5L47 20.5V50C47 51.6569 45.6569 53 44 53H22C20.3431 53 19 51.6569 19 50V14Z"
          fill="#FFFFFF"
        />
        <path d="M37.5 11L47 20.5H40.5C38.8431 20.5 37.5 19.1569 37.5 17.5V11Z" fill="#BFDBFE" />
        <text
          x="33"
          y="42"
          textAnchor="middle"
          fill="#1E3A8A"
          fontSize="21"
          fontWeight="800"
          fontFamily="Plus Jakarta Sans, Inter, system-ui, sans-serif"
        >
          P
        </text>
      </svg>
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
