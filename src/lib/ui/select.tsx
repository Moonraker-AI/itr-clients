import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';

type SelectProps = PropsWithChildren<{
  name?: string | undefined;
  id?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  class?: string | undefined;
}>;

const BASE =
  'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ' +
  'ring-offset-background placeholder:text-muted-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const Select: FC<SelectProps> = ({ class: className, children, ...rest }) => (
  <select class={cn(BASE, className)} {...rest}>
    {children}
  </select>
);
