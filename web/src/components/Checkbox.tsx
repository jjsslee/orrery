import { useEffect, useRef } from 'react';

interface Props {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean, altKey: boolean) => void;
  label: string;
  className?: string;
}

/** Native checkbox with tri-state support; the whole label row is the hit target. */
export function Checkbox({ checked, indeterminate = false, onChange, label, className }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={className}
      checked={checked}
      aria-checked={indeterminate && !checked ? 'mixed' : checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked, (e.nativeEvent as MouseEvent).altKey ?? false)}
      onClick={(e) => { if (e.altKey) { e.preventDefault(); onChange(true, true); } }}
    />
  );
}
