// Test support for the human layer tools: the bundled default priors, checked.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePriorsFile } from '../../../../shared/cycle-formats.ts';
import type { ProfilePriors } from '../../../../shared/profile.ts';

export function readPriorsDefault(): ProfilePriors {
  const v = validatePriorsFile(JSON.parse(readFileSync(join(import.meta.dirname, '../../../../shared/profile-priors-default.json'), 'utf8')));
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.value;
}
