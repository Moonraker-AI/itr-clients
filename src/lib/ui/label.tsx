import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';

type LabelProps = PropsWithChildren<{ for?: string | undefined; class?: string | undefined }>;

export const Label: FC<LabelProps> = ({ for: htmlFor, class: className, children }) => (
  <label
    for={htmlFor}
    class={cn(
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
  >
    {children}
  </label>
);
