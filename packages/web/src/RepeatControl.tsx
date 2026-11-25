import {
  MAX_REPEAT_EVERY,
  MIN_REPEAT_EVERY,
  REPEAT_CHOICES,
  REPEAT_NEEDS_DUE_DATE_HINT,
  REPEAT_UNITS,
  type RepeatChoice,
  type Repeat,
  type RepeatForm,
  type RepeatUnit,
  UNIT_LABELS,
  chooseRepeat,
} from './repeat';
import { labelClass as fieldLabelClass, selectClass } from './ui';

type Props = {
  // Prefix for element ids, unique on the page.
  idBase: string;
  // Accessible names. With visibleLabels the select and the number field are
  // labelled by visible text ("Repeats", "Every") instead.
  names: { choice: string; every: string; unit: string };
  visibleLabels?: boolean;
  form: RepeatForm;
  // The repeat before this edit (the stored one; null in the add form). Custom
  // starts from it.
  seed: Repeat | null;
  // A repeat needs a due date. Without one the controls are disabled and the
  // select is described by the hint, which the caller shows (see RepeatHint).
  available: boolean;
  // A request is pending: the values cannot change, but focus stays.
  locked: boolean;
  invalid: boolean;
  errorId?: string;
  className: string;
  onChange: (form: RepeatForm) => void;
};

export const repeatHintId = (idBase: string) => `${idBase}-repeat-hint`;

// The "Repeats" select, and with Custom the "Every" number field and a unit
// select. Without a due date they are disabled: dimmed, out of the tab order
// and impossible to open or change, with the visible hint saying why. While a
// request is pending they are locked like the other pending controls, with
// aria-disabled (and readOnly where it exists) instead of disabled, so a
// focused control keeps keyboard focus; changes are ignored.
export function RepeatControl({
  idBase,
  names,
  visibleLabels = false,
  form,
  seed,
  available,
  locked,
  invalid,
  errorId,
  className,
  onChange,
}: Props) {
  const disabled = !available;
  const ignored = locked || disabled;
  const dimmed = 'aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60';
  const describedBy = [!available ? repeatHintId(idBase) : '', invalid && errorId ? errorId : '']
    .filter(Boolean)
    .join(' ');
  const choiceId = `${idBase}-repeat`;
  const everyId = `${idBase}-repeat-every`;
  const labelClass = `${fieldLabelClass} px-1`;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        {visibleLabels && (
          <label htmlFor={choiceId} className={labelClass}>
            Repeats
          </label>
        )}
        <select
          id={choiceId}
          data-action="edit-repeat"
          aria-label={visibleLabels ? undefined : names.choice}
          value={form.choice}
          disabled={disabled}
          aria-disabled={(locked && !disabled) || undefined}
          aria-invalid={(invalid && form.choice !== 'custom') || undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => {
            if (!ignored) onChange(chooseRepeat(form, event.target.value as RepeatChoice, seed));
          }}
          className={`${className} ${selectClass} ${dimmed}`}
        >
          {REPEAT_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      {form.choice === 'custom' && (
        <>
          <div className="flex flex-col gap-1.5">
            {visibleLabels && (
              <label htmlFor={everyId} className={labelClass}>
                Every
              </label>
            )}
            <input
              id={everyId}
              type="number"
              inputMode="numeric"
              data-action="edit-repeat-every"
              aria-label={visibleLabels ? undefined : names.every}
              min={MIN_REPEAT_EVERY}
              max={MAX_REPEAT_EVERY}
              step={1}
              value={form.every}
              disabled={disabled}
              readOnly={locked && !disabled}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid && errorId ? errorId : undefined}
              onChange={(event) => {
                if (!ignored) onChange({ ...form, every: event.target.value });
              }}
              className={`${className} w-20 text-center read-only:opacity-60 disabled:cursor-not-allowed disabled:opacity-60`}
            />
          </div>
          <select
            data-action="edit-repeat-unit"
            aria-label={names.unit}
            value={form.unit}
            disabled={disabled}
            aria-disabled={(locked && !disabled) || undefined}
            onChange={(event) => {
              if (!ignored) onChange({ ...form, unit: event.target.value as RepeatUnit });
            }}
            className={`${className} ${selectClass} ${dimmed}`}
          >
            {REPEAT_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {UNIT_LABELS[unit]}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
}

// The visible reason the Repeats control is disabled.
export function RepeatHint({ idBase, className = '' }: { idBase: string; className?: string }) {
  return (
    <p id={repeatHintId(idBase)} className={`m-0 text-[13px] text-ink-3 ${className}`}>
      {REPEAT_NEEDS_DUE_DATE_HINT}
    </p>
  );
}
