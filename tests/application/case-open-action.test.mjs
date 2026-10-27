import assert from 'node:assert/strict';
import test from 'node:test';
import { caseOpenAction } from '../../src/application/case-open-action.ts';
import { createChestAppearance } from '../../src/domain/chest-appearance.ts';
const make = (id, status, caseId = 'ender') => ({
  id,
  status,
  caseId,
  appearance: createChestAppearance(),
});

test('inspecting a used case offers opening another owned copy of the same type', () => {
  const available = make('gift', 'available');
  const result = caseOpenAction(
    [make('used', 'opened'), make('other', 'available', 'other'), available],
    'ender',
    'used',
  );
  assert.equal(result.target, available);
  assert.equal(result.availableCount, 1);
  assert.equal(
    result.label,
    'Открыть сундук',
    'no «следующий»: the same label whichever chest of the stack opens',
  );
});
test('selected available copy is preserved; consumed copies cannot be opened again', () => {
  const own = make('bought', 'available');
  assert.equal(caseOpenAction([make('first', 'available'), own], 'ender', 'bought').target, own);
  const result = caseOpenAction([make('used', 'opened')], 'ender', 'used');
  assert.equal(result.target, undefined);
  assert.equal(result.availableCount, 0);
  assert.equal(result.action, 'leave');
  assert.equal(result.label, 'Вернуться в инвентарь');
});
test('pending openings can be resumed when there are no fresh copies', () => {
  const pending = make('pending', 'opening');
  const result = caseOpenAction([pending], 'ender');
  assert.equal(result.target, pending);
  assert.equal(result.label, 'Продолжить открытие');
});

test('counts and the next chest stay within the inspected variant (its inventory stack)', async () => {
  const { caseOpenAction } = await import('../../src/application/case-open-action.ts');
  const { createChestAppearance, changeChestAppearance } =
    await import('../../src/domain/chest-appearance.ts');
  const plain = createChestAppearance(),
    mossy = changeChestAppearance(createChestAppearance(), {
      modifications: [{ id: 'moss', intensity: 0.8 }],
    });
  const make = (id, appearance, status = 'available', extra = {}) => ({
    id,
    caseId: 'ender',
    status,
    appearance,
    ...extra,
  });
  const instances = [
    make('p1', plain),
    make('p2', plain),
    make('p3', plain),
    make('m1', mossy, 'opened', { sessionId: 's', reward: { id: 'r' } }),
    make('m2', mossy),
  ];
  const inspectingMossy = caseOpenAction(instances, 'ender', 'm1');
  assert.equal(inspectingMossy.availableCount, 1, 'one mossy chest left, not every ender chest');
  assert.equal(inspectingMossy.target.id, 'm2', 'the next chest is another mossy one');
  assert.equal(caseOpenAction(instances, 'ender', 'p2').availableCount, 3);
  const lastMossy = caseOpenAction(
    instances.filter((item) => item.id !== 'm2'),
    'ender',
    'm1',
  );
  assert.equal(lastMossy.target, undefined, 'another kind of chest is never slipped in');
  assert.equal(lastMossy.action, 'leave');
  assert.equal(lastMossy.label, 'Вернуться в инвентарь');
});
