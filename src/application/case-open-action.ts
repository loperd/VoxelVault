import { isConsumed, nextOwnedCase, type CaseInstance } from '../domain/case-instance.ts';
import { variantKey } from './inventory-groups.ts';

export type CaseAction = 'open' | 'continue' | 'leave';

/**
 * What the case screen offers. Everything stays within the inspected chest's variant (same look
 * and condition, i.e. its inventory stack): the inspected chest if it can still be opened, else
 * another chest just like it. With none left, it offers the way back to the inventory (every chest
 * is unique, so "another one like it" cannot be bought; a store is a separate feature). A different
 * chest is never slipped in.
 */
export function caseOpenAction(
  instances: readonly CaseInstance[],
  caseId: string,
  inspectedId?: string,
) {
  const inspected = instances.find((item) => item.id === inspectedId && item.caseId === caseId);
  const variant = inspected ? variantKey(inspected) : undefined;
  const sameVariant =
    variant === undefined
      ? instances.filter((item) => item.caseId === caseId)
      : instances.filter((item) => item.caseId === caseId && variantKey(item) === variant);
  const target =
    inspected && !isConsumed(inspected) ? inspected : nextOwnedCase(sameVariant, caseId);
  const action: CaseAction = !target ? 'leave' : target.status === 'opening' ? 'continue' : 'open';
  // One label for opening, whichever chest of the stack it takes: «Открыть сундук» while any is left.
  const label =
    action === 'leave'
      ? 'Вернуться в инвентарь'
      : action === 'continue'
        ? 'Продолжить открытие'
        : 'Открыть сундук';
  return {
    target,
    action,
    label,
    availableCount: sameVariant.filter((item) => item.status === 'available').length,
  };
}
