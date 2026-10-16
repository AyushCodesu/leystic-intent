export function LeysticMark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      width={size}
      height={size}
      className={`shrink-0 rounded-[4px] bg-[#577BF4]/15 ring-1 ring-[#577BF4]/30 ${className}`}
    >
      <path
        d="M5 15.5c3.5 0 4-7 7-7s3.5 7 7 7"
        stroke="#577BF4"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="5" cy="15.5" r="1.6" fill="#577BF4" />
      <circle cx="12" cy="8.5" r="1.6" fill="#577BF4" fillOpacity="0.75" />
      <circle cx="19" cy="15.5" r="1.6" fill="#577BF4" />
    </svg>
  );
}
