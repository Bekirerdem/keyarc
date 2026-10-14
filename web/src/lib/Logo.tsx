/** The keystone: an arch held together by the red stone at its top, the way the chest holds the team's money. */
export function Logo({ size = 28, dark = false, plate = false }: { size?: number; dark?: boolean; plate?: boolean }) {
  const ink = dark ? "#f3ecdf" : "#1d1a16";
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {plate && <rect width="64" height="64" rx="14" fill={dark ? "#1d1a16" : "#f3ecdf"} />}
      <path d="M14 54V36a18 18 0 0 1 36 0v18" fill="none" stroke={ink} strokeWidth="9" />
      <path d="M25 7h14l-2.5 16h-9z" fill="#c8241c" />
    </svg>
  );
}
