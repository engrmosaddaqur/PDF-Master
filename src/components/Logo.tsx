import React from 'react';

export const PdfMasterLogo: React.FC<{ size?: number; showWordmark?: boolean }> = ({
  size = 36,
  showWordmark = true,
}) => {
  return (
    <div className="flex items-center gap-2.5 shrink-0">
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 rounded-xl shadow-sm"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="pmLogoBg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#142B4A" />
            <stop offset="100%" stopColor="#0F172A" />
          </linearGradient>
          <linearGradient id="pmLogoAccent" x1="20" y1="42" x2="46" y2="52" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#2563EB" />
            <stop offset="100%" stopColor="#06B6D4" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="url(#pmLogoBg)" />
        <path
          d="M17 12C17 10.3431 18.3431 9 20 9H37L49 21V52C49 53.6569 47.6569 55 46 55H20C18.3431 55 17 53.6569 17 52V12Z"
          fill="#FFFFFF"
        />
        <path d="M37 9L49 21H40C38.3431 21 37 19.6569 37 18V9Z" fill="#CBD5E1" />
        <rect x="22" y="26" width="20" height="3.2" rx="1.6" fill="#142B4A" />
        <rect x="22" y="32.5" width="15" height="2.8" rx="1.4" fill="#64748B" opacity="0.6" />
        <rect x="22" y="40" width="20" height="8" rx="2.5" fill="url(#pmLogoAccent)" />
        <path
          d="M27 44H37M33.5 41.5L37 44L33.5 46.5"
          stroke="#FFFFFF"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {showWordmark && (
        <span className="font-display text-lg font-extrabold tracking-tight text-[#142B4A] dark:text-white whitespace-nowrap shrink-0">
          PDF <span className="text-[#2563EB] dark:text-[#38BDF8]">MASTER</span>
        </span>
      )}
    </div>
  );
};
