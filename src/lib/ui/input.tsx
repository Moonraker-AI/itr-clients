import type { FC } from 'hono/jsx';
import { cn } from './cn.js';

type InputMode = 'search' | 'email' | 'url' | 'text' | 'numeric' | 'none' | 'tel' | 'decimal';

type InputProps = {
  type?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  value?: string | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  readonly?: boolean | undefined;
  autocomplete?: string | undefined;
  inputmode?: InputMode | undefined;
  pattern?: string | undefined;
  min?: string | number | undefined;
  max?: string | number | undefined;
  step?: string | number | undefined;
  class?: string | undefined;
};

const BASE =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
  'ring-offset-background placeholder:text-muted-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const Input: FC<InputProps> = ({ type = 'text', class: className, ...rest }) => (
  <input type={type} class={cn(BASE, className)} {...rest} />
);

type TextareaProps = {
  name?: string | undefined;
  id?: string | undefined;
  rows?: number | undefined;
  required?: boolean | undefined;
  placeholder?: string | undefined;
  class?: string | undefined;
  children?: string | undefined;
};

export const Textarea: FC<TextareaProps> = ({ class: className, children, ...rest }) => (
  <textarea
    class={cn(
      'flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
        'ring-offset-background placeholder:text-muted-foreground ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
        'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...rest}
  >
    {children}
  </textarea>
);
