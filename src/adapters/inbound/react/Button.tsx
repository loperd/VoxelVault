import type { ButtonHTMLAttributes, Ref } from 'react';

/** Shared button using the original project's btn / btn-primary / btn-secondary styles. */
export function Button({
  variant = 'primary',
  className = '',
  ref,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'secondary';
  readonly ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button {...props} ref={ref} type={type} className={`btn btn-${variant} ${className}`.trim()} />
  );
}
