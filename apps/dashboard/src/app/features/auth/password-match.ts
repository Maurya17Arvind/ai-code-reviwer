import { type AbstractControl, type ValidationErrors, type ValidatorFn } from '@angular/forms';
import { PASSWORD_MIN_LENGTH } from '@acra/shared-contracts';

export { PASSWORD_MIN_LENGTH };

/** Group validator: `confirm` must equal `password`. */
export const passwordsMatch: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const password = group.get('password')?.value as string | undefined;
  const confirm = group.get('confirm')?.value as string | undefined;
  return password && confirm && password !== confirm ? { mismatch: true } : null;
};
