import type { ButtonHTMLAttributes, Ref } from 'react';

/** Shared button using the original project's btn / btn-green / btn-transparent styles. */
export function Button({
  variant = 'green',
  className = '',
  ref,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'green' | 'transparent';
  readonly ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button {...props} ref={ref} type={type} className={`btn btn-${variant} ${className}`.trim()} />
  );
}
