import React, { useEffect, useRef, useState } from 'react';

interface AccountMenuProps {
  /** Name or email of the signed-in person. */
  label: string;
  onSignOut: () => void;
  /** Shows the label next to the icon when there is room for it. */
  showLabel?: boolean;
}

/**
 * The signed-in account, with a way out.
 *
 * Deliberately a menu rather than a button that signs you out on click: an avatar icon gives no
 * hint that clicking it ends your session, and doing it by accident mid-edit is a bad surprise.
 */
export const AccountMenu: React.FC<AccountMenuProps> = ({ label, onSignOut, showLabel = true }) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-on-surface-variant hover:text-primary transition-colors duration-300 cursor-pointer p-sm rounded-full hover:bg-surface-variant flex items-center justify-center gap-xs"
        title={`Signed in as ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="material-symbols-outlined text-[20px]">account_circle</span>
        {showLabel && (
          <span className="hidden lg:inline text-[11px] font-label-caps tracking-wider max-w-[170px] truncate">
            {label}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-xs z-50 w-60 bg-surface-container border border-outline-variant/50 rounded-lg shadow-xl p-xs"
        >
          <div className="px-sm py-xs border-b border-outline-variant/30 mb-xs">
            <div className="text-[10px] font-label-caps uppercase tracking-wider text-on-surface-variant">
              Signed in as
            </div>
            <div className="text-[13px] text-on-surface truncate">{label}</div>
          </div>

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="w-full flex items-center gap-sm px-sm py-xs rounded-md hover:bg-surface-container-highest transition-colors text-left cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">logout</span>
            <span className="text-[13px] text-on-surface">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
};
