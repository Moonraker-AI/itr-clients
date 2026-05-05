import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';

type Variant = 'default' | 'destructive' | 'success';

const VARIANTS: Record<Variant, string> = {
  default: 'bg-card text-card-foreground border-border',
  destructive:
    'border-destructive/50 text-destructive bg-destructive/10 [&>svg]:text-destructive',
  success: 'border-chart-4/40 text-chart-4 bg-chart-4/10',
};

type Props = PropsWithChildren<{ variant?: Variant; class?: string }>;

export const Alert: FC<Props> = ({ variant = 'default', class: className, children }) => (
  <div role="alert" class={cn('relative w-full rounded-lg border p-4 text-sm', VARIANTS[variant], className)}>
    {children}
  </div>
);

export const AlertTitle: FC<{ class?: string; children?: unknown }> = ({ class: className, children }) => (
  <h5 class={cn('mb-1 font-medium leading-none tracking-tight', className)}>{children}</h5>
);

export const AlertDescription: FC<{ class?: string; children?: unknown }> = ({ class: className, children }) => (
  <div class={cn('text-sm opacity-90', className)}>{children}</div>
);
