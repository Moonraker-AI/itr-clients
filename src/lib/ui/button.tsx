import type { FC, PropsWithChildren } from 'hono/jsx';
import { cn } from './cn.js';

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
type Size = 'default' | 'sm' | 'lg' | 'icon';

const VARIANTS: Record<Variant, string> = {
  default:
    'bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline:
    'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-xs',
  link: 'text-primary underline-offset-4 hover:underline',
};

const SIZES: Record<Size, string> = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 px-3 text-sm',
  lg: 'h-11 px-6',
  icon: 'h-10 w-10',
};

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:pointer-events-none disabled:opacity-50';

type ButtonProps = PropsWithChildren<{
  type?: 'button' | 'submit' | 'reset';
  variant?: Variant;
  size?: Size;
  class?: string;
  id?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  /** HTML5 form-association attribute. */
  form?: string;
  /** Pass-through data-* attrs. */
  data?: Record<string, string>;
}>;

export const Button: FC<ButtonProps> = ({
  type = 'button',
  variant = 'default',
  size = 'default',
  class: className,
  data,
  children,
  ...rest
}) => {
  const cls = cn(BASE, VARIANTS[variant], SIZES[size], className);
  const dataAttrs: Record<string, string> = {};
  if (data) for (const [k, v] of Object.entries(data)) dataAttrs[`data-${k}`] = v;
  return (
    <button type={type} class={cls} {...rest} {...dataAttrs}>
      {children}
    </button>
  );
};

type LinkButtonProps = PropsWithChildren<{
  href: string;
  variant?: Variant;
  size?: Size;
  class?: string;
}>;

export const LinkButton: FC<LinkButtonProps> = ({
  href,
  variant = 'default',
  size = 'default',
  class: className,
  children,
}) => {
  const cls = cn(BASE, VARIANTS[variant], SIZES[size], className);
  return (
    <a href={href} class={cls}>
      {children}
    </a>
  );
};
