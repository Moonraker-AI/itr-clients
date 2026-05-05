import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';

type Props = PropsWithChildren<{ class?: string }>;

export const Card: FC<Props> = ({ class: className, children }) => (
  <div
    class={cn(
      'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
      className,
    )}
  >
    {children}
  </div>
);

export const CardHeader: FC<Props> = ({ class: className, children }) => (
  <div class={cn('flex flex-col space-y-1.5 p-6', className)}>{children}</div>
);

export const CardTitle: FC<Props> = ({ class: className, children }) => (
  <h3
    class={cn('text-lg font-semibold leading-none tracking-tight', className)}
  >
    {children}
  </h3>
);

export const CardDescription: FC<Props> = ({ class: className, children }) => (
  <p class={cn('text-sm text-muted-foreground', className)}>{children}</p>
);

export const CardContent: FC<Props> = ({ class: className, children }) => (
  <div class={cn('p-6 pt-0', className)}>{children}</div>
);

export const CardFooter: FC<Props> = ({ class: className, children }) => (
  <div class={cn('flex items-center p-6 pt-0', className)}>{children}</div>
);
