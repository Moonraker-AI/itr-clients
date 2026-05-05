import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';

type Props = PropsWithChildren<{ class?: string }>;

export const Table: FC<Props> = ({ class: className, children }) => (
  <div class="relative w-full overflow-auto">
    <table class={cn('w-full caption-bottom text-sm', className)}>{children}</table>
  </div>
);

export const Thead: FC<Props> = ({ class: className, children }) => (
  <thead class={cn('[&_tr]:border-b border-border', className)}>{children}</thead>
);

export const Tbody: FC<Props> = ({ class: className, children }) => (
  <tbody class={cn('[&_tr:last-child]:border-0', className)}>{children}</tbody>
);

type TrProps = PropsWithChildren<{
  class?: string | undefined;
  /** When set, the entire row becomes clickable and navigates here on click.
   * Requires the consumer page to include the row-link script (or AdminShell). */
  href?: string | undefined;
}>;

export const Tr: FC<TrProps> = ({ class: className, href, children }) => {
  const dataAttrs: Record<string, string> = href ? { 'data-href': href } : {};
  return (
    <tr
      class={cn(
        'border-b border-border transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        href ? 'cursor-pointer' : null,
        className,
      )}
      {...dataAttrs}
    >
      {children}
    </tr>
  );
};

export const Th: FC<Props> = ({ class: className, children }) => (
  <th
    class={cn(
      'h-10 px-3 text-left align-middle font-medium text-muted-foreground',
      className,
    )}
  >
    {children}
  </th>
);

export const Td: FC<Props> = ({ class: className, children }) => (
  <td class={cn('px-3 py-3 align-middle', className)}>{children}</td>
);
