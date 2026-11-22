import type { ReactNode } from "react";

/** Hand-drawn 16×16 line icons: 1.5px stroke, round caps/joins, currentColor. */
const PATHS = {
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
      <path d="M2.25 6.5h11.5M5.5 1.75v3M10.5 1.75v3" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
    </>
  ),
  hash: <path d="M6.25 2.25l-1.5 11.5M11.25 2.25l-1.5 11.5M2.75 5.75h11M2.25 10.25h11" />,
  list: (
    <>
      <path d="M5.75 4h7.5M5.75 8h7.5M5.75 12h7.5" />
      <path d="M2.75 4h.01M2.75 8h.01M2.75 12h.01" strokeWidth={2} />
    </>
  ),
  folder: <path d="M2 4.75c0-.83.67-1.5 1.5-1.5h2.9l1.5 1.75h4.6c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5z" />,
  chevron: <path d="M6 3.75L10.25 8 6 12.25" />,
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4l3.35 3.35" />
    </>
  ),
  bell: <path d="M4 11.25V7.5a4 4 0 0 1 8 0v3.75l1.25 1.25H2.75zM6.5 14h3" />,
  repeat: <path d="M2.75 7.25V6.5a2 2 0 0 1 2-2h8.5M11 2.25l2.25 2.25L11 6.75M13.25 8.75v.75a2 2 0 0 1-2 2h-8.5M5 13.75L2.75 11.5 5 9.25" />,
  flag: <path d="M3.75 14.25V2.5M3.75 2.75h8.5l-1.75 3.5 1.75 3.5h-8.5" />,
  share: <path d="M8 1.75v8.5M5 4.5l3-3 3 3M5.5 7H4.25c-.69 0-1.25.56-1.25 1.25v4.5c0 .69.56 1.25 1.25 1.25h7.5c.69 0 1.25-.56 1.25-1.25v-4.5C13 7.56 12.44 7 11.75 7H10.5" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.25} />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`ico${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
