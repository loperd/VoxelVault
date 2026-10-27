import {
  partConditions,
  resolveModifications,
  type ChestAppearance,
} from '../../../domain/chest-appearance.ts';
import type { ChestModificationProfile } from '../../../domain/chest-modifications.ts';
import { damageLevel, integrityPercent } from '../../../application/inventory-groups.ts';

function IntegrityBubbles({
  integrity,
  label,
}: {
  readonly integrity: number;
  readonly label: string;
}) {
  return (
    <span
      className="inventory-card__damage-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={integrity}
    >
      {[1, 2, 3, 4].map((rank) => (
        <i key={rank} data-active={rank <= Math.ceil(integrity / 25)} />
      ))}
    </span>
  );
}

export function ChestIndicators({
  appearance,
  profile,
  status,
  showFeatures = true,
  showCondition = true,
  showParts = true,
}: {
  readonly appearance: ChestAppearance;
  readonly profile: ChestModificationProfile;
  readonly showFeatures?: boolean;
  readonly showCondition?: boolean;
  readonly showParts?: boolean;
  /** Stacks show their representative's exact value too: one number, no ranges. */
  readonly grouped?: boolean;
  readonly status?: 'available' | 'opening' | 'opened' | 'destroyed';
}) {
  // Parts and labels come from the model profile: each model reports its own condition rows.
  const conditions = partConditions(appearance, profile);
  const wear = damageLevel(Math.max(0, ...conditions.map((item) => item.value)));
  const features = resolveModifications(appearance, profile).filter(
    (item) => item.definition.kind !== 'fracture',
  );
  const percentage = (value: number) => `${integrityPercent(value)}%`;
  const chestIntegrity = integrityPercent(Math.max(0, ...conditions.map((item) => item.value)));
  // Zero integrity is represented by the destroyed lifecycle state, never as a usable chest.
  const displayedIntegrity = status === 'destroyed' ? 0 : Math.max(1, chestIntegrity);
  return (
    <div
      className={`chest-indicators${showParts ? ' chest-indicators--parts' : ''}${showCondition && !showParts ? ' chest-indicators--summary' : ''}`}
    >
      {showCondition && (
        <div className="chest-indicators__wear" data-severity={wear.rank}>
          <span>Состояние</span>
          <IntegrityBubbles integrity={displayedIntegrity} label="Состояние сундука" />
        </div>
      )}
      {showParts && (
        <div className="chest-damage-list" aria-label="Сохранность сундука">
          {conditions.map(({ part, value }) => {
            const level = damageLevel(value);
            return (
              <div className="chest-damage" key={part.id} data-severity={level.rank}>
                <div className="chest-damage__label">
                  <span>{part.label}</span>
                  <strong>{percentage(value)}</strong>
                </div>
                <IntegrityBubbles
                  integrity={integrityPercent(value)}
                  label={`Сохранность: ${part.label}`}
                />
              </div>
            );
          })}
        </div>
      )}
      {showFeatures && features.length > 0 && (
        <details className="chest-indicators__details">
          <summary>
            Особенности сундука <span>{features.length}</span>
          </summary>
          <ul>
            {features.map((item) => (
              <li key={item.definition.id}>{item.definition.label}</li>
            ))}
          </ul>
        </details>
      )}
      {status && (
        <p className="chest-indicators__status">
          <span>Состояние</span>{' '}
          {status === 'available'
            ? 'Готов к открытию'
            : status === 'opening'
              ? 'Открывается'
              : status === 'destroyed'
                ? 'Разрушен'
                : 'Открыт'}
        </p>
      )}
    </div>
  );
}
