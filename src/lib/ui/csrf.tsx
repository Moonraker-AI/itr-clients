import type { FC } from 'hono/jsx';

export const CsrfInput: FC<{ token: string }> = ({ token }) => (
  <input type="hidden" name="_csrf" value={token} />
);
