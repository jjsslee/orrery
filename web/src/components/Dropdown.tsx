import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface DropdownOption { value: string; label: ReactNode; hint?: ReactNode; disabled?: boolean }

interface Props {
  value: string;
  options: DropdownOption[];
  onChange(v: string): void;
  label: string;
  prefix?: ReactNode;
  width?: number;
  mono?: boolean;
}

/** Accessible listbox dropdown: button + popup, arrow keys, Escape, click-outside. */
export function Dropdown({ value, options, onChange, label, prefix, width, mono }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, options, value]);

  const choose = (i: number) => { const o = options[i]; if (!o || o.disabled) return; onChange(o.value); setOpen(false); };

  return (
    <div className={`dd ${open ? 'open' : ''}`} ref={root} style={{ width }}>
      <button
        type="button"
        className={`dd-btn ${mono ? 'mono' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) setOpen(true); else setActive((a) => Math.min(options.length - 1, Math.max(0, a + (e.key === 'ArrowDown' ? 1 : -1)))); }
          if (e.key === 'Enter' && open) { e.preventDefault(); choose(active); }
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        {prefix && <span className="dd-prefix">{prefix}</span>}
        <span className="dd-value">{current?.label ?? value}</span>
        <ChevronDown size={14} className="dd-chev" aria-hidden />
      </button>
      {open && (
        <ul className="dd-list" role="listbox" aria-label={label}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`dd-item ${i === active ? 'active' : ''} ${o.disabled ? 'disabled' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className={`dd-item-label ${mono ? 'mono' : ''}`}>{o.label}</span>
              {o.hint && <span className="dd-item-hint">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
