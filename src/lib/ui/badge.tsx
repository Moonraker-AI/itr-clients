import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';

type Variant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success';

const VARIANTS: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
  outline: 'border border-border text-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
  success: 'bg-chart-4/20 text-chart-4 border border-chart-4/30',
};

type Props = PropsWithChildren<{ variant?: Variant; class?: string }>;

export const Badge: FC<Props> = ({ variant = 'default', class: className, children }) => (
  <span
    class={cn(
      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
      VARIANTS[variant],
      className,
    )}
  >
    {children}
  </span>
);
