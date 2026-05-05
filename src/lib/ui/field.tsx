import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';
import { Label } from './label.js';

type FieldProps = PropsWithChildren<{
  label?: string;
  for?: string;
  hint?: string;
  error?: string;
  class?: string;
}>;

export const Field: FC<FieldProps> = ({ label, for: htmlFor, hint, error, class: className, children }) => (
  <div class={cn('space-y-2', className)}>
    {label ? <Label for={htmlFor}>{label}</Label> : null}
    {children}
    {error ? (
      <p class="text-xs text-destructive">{error}</p>
    ) : hint ? (
      <p class="text-xs text-muted-foreground">{hint}</p>
    ) : null}
  </div>
);
