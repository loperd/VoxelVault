import { useCallback } from 'react';

/** React mounts the host; the presentation adapter alone owns its contents and lifetime. */
export function PresentationHost({
  element,
  className,
}: {
  readonly element?: HTMLElement;
  readonly className: string;
}) {
  const mount = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host || !element) return;
      host.append(element);
      return () => {
        if (element.parentNode === host) element.remove();
      };
    },
    [element],
  );
  return <div className={className} ref={mount} />;
}
