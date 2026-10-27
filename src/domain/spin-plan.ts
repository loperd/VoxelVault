import { DomainError } from './error.ts';
import { assertTarget, type TargetSelection } from './strip.ts';

export interface SpinSettings {
  /** Deceleration in slot strides per second squared (legacy: 500 px / 155 px); sets the travel time. */
  readonly deceleration: number;
  readonly nominalTimeSeconds: number;
  readonly timeScale: number;
}

export const DEFAULT_SPIN_SETTINGS: SpinSettings = Object.freeze({
  deceleration: 500 / 155,
  nominalTimeSeconds: 5,
  timeScale: 1.38,
});

/** No wind-up: the strip is already running when the flash clears. */
export const WIND_UP_SECONDS = 0;
export const WIND_UP_STRIDES = 0;
/** Share of the travel spent accelerating; the rest is one long deceleration to rest. */
export const ACCELERATION_SHARE = 0.1;

export type SpinPhase = 'wind-up' | 'accelerating' | 'decelerating' | 'stopped';

export interface SpinPlan {
  readonly slotCount: number;
  readonly targetIndex: number;
  readonly fullTurns: number;
  readonly startPosition: number;
  /** Always the target's centre (plus whole turns): the card stops exactly under the pointer. */
  readonly endPosition: number;
  readonly distance: number;
  readonly windUpSeconds: number;
  readonly travelSeconds: number;
  readonly durationSeconds: number;
}

/**
 * Positions are in slot strides, so the motion and the landing are the same at any viewport width,
 * and a function of elapsed time only, so any frame rate samples the same curve.
 */
export function createSpinPlan(
  selection: TargetSelection,
  settings: SpinSettings = DEFAULT_SPIN_SETTINGS,
  startPosition = 0,
): SpinPlan {
  assertTarget(selection);
  assertSpinSettings(settings);
  if (!Number.isFinite(startPosition) || startPosition < 0) {
    throw new DomainError('INVALID_SPIN', 'The start position must be finite and nonnegative.');
  }

  const slotCount = selection.slots.length;
  const landing = selection.targetIndex + 0.5;
  const delta = (((landing - (startPosition % slotCount)) % slotCount) + slotCount) % slotCount;
  const minimumDistance = (settings.deceleration * settings.nominalTimeSeconds ** 2) / 2;
  const fullTurns = Math.ceil(minimumDistance / slotCount);
  const distance = fullTurns * slotCount + delta;
  const travelSeconds = Math.sqrt((2 * distance) / settings.deceleration) * settings.timeScale;
  const durationSeconds = WIND_UP_SECONDS + travelSeconds;
  const endPosition = startPosition + distance;
  if (
    ![distance, durationSeconds, endPosition].every(Number.isFinite) ||
    !Number.isSafeInteger(fullTurns) ||
    distance <= 0 ||
    travelSeconds <= 0
  ) {
    throw new DomainError(
      'INVALID_SPIN',
      'The configured spin exceeds the supported numeric range.',
    );
  }

  return Object.freeze({
    slotCount,
    targetIndex: selection.targetIndex,
    fullTurns,
    startPosition,
    endPosition,
    distance,
    windUpSeconds: WIND_UP_SECONDS,
    travelSeconds,
    durationSeconds,
  });
}

// Normalised travel u in [0, 1]: speed ramps linearly to its peak over ACCELERATION_SHARE, then
// falls as the square of the remaining time, so speed and position are continuous everywhere and
// the strip creeps to a stop with no final jolt. PEAK makes the whole curve cover distance 1.
const A = ACCELERATION_SHARE,
  PEAK = 1 / (A / 2 + (1 - A) / 3);
const travelled = (u: number) =>
  u < A
    ? (PEAK * u * u) / (2 * A)
    : (PEAK * A) / 2 + ((PEAK * (1 - A)) / 3) * (1 - ((1 - u) / (1 - A)) ** 3);
const speed = (u: number) => (u < A ? (PEAK * u) / A : PEAK * ((1 - u) / (1 - A)) ** 2);

export function positionAt(plan: SpinPlan, elapsedSeconds: number): number {
  assertElapsed(elapsedSeconds);
  if (elapsedSeconds >= plan.durationSeconds) return plan.endPosition;
  if (elapsedSeconds < plan.windUpSeconds) {
    return (
      plan.startPosition -
      WIND_UP_STRIDES * Math.sin((Math.PI * elapsedSeconds) / plan.windUpSeconds) ** 2
    );
  }
  return (
    plan.startPosition +
    plan.distance * travelled((elapsedSeconds - plan.windUpSeconds) / plan.travelSeconds)
  );
}

/** Strides per second; negative while winding up. */
export function velocityAt(plan: SpinPlan, elapsedSeconds: number): number {
  assertElapsed(elapsedSeconds);
  if (elapsedSeconds >= plan.durationSeconds) return 0;
  if (elapsedSeconds < plan.windUpSeconds) {
    return (
      ((-WIND_UP_STRIDES * Math.PI) / plan.windUpSeconds) *
      Math.sin((2 * Math.PI * elapsedSeconds) / plan.windUpSeconds)
    );
  }
  return (
    (plan.distance / plan.travelSeconds) *
    speed((elapsedSeconds - plan.windUpSeconds) / plan.travelSeconds)
  );
}

export function spinPhaseAt(plan: SpinPlan, elapsedSeconds: number): SpinPhase {
  assertElapsed(elapsedSeconds);
  if (elapsedSeconds >= plan.durationSeconds) return 'stopped';
  if (elapsedSeconds < plan.windUpSeconds) return 'wind-up';
  return elapsedSeconds - plan.windUpSeconds < plan.travelSeconds * A
    ? 'accelerating'
    : 'decelerating';
}

export function assertSpinSettings(settings: SpinSettings): void {
  if (
    ![settings.deceleration, settings.nominalTimeSeconds, settings.timeScale].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new DomainError('INVALID_SPIN', 'Spin settings must be positive.');
  }
}

function assertElapsed(elapsedSeconds: number): void {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new DomainError('INVALID_SPIN', 'Elapsed time must be finite and nonnegative.');
  }
}
