import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function NumberField({ label, value, onChange, unit, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1, hint }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}) {
  return (
    <label className="number-field" title={hint}>
      <span>{label}</span>
      <div><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />{unit && <i>{unit}</i>}</div>
    </label>
  );
}

export function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function ToggleField({ label, checked, onChange, description }: { label: string; checked: boolean; onChange: (checked: boolean) => void; description?: string }) {
  return (
    <label className="toggle-field">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i className="toggle-switch" />
    </label>
  );
}

export function SelectField({ label, value, onChange, children }: { label: string; value: string | number; onChange: (value: string) => void; children: ReactNode }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select></label>;
}

export function ConfigSection({ title, badge, children, defaultOpen = false }: { title: string; badge?: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="config-section" open={open}>
      <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}><span><ChevronDown size={14} />{title}</span>{badge && <i>{badge}</i>}</summary>
      <div className="config-section-content">{children}</div>
    </details>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="field-grid">{children}</div>;
}
