import { z } from 'zod';

export const MAX_PROPERTY_KEYS = 100;
export const MAX_PROPERTY_VALUE_CHARS = 4096;

function isValueWithinLimit(v: unknown): boolean {
  const str = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return str.length <= MAX_PROPERTY_VALUE_CHARS;
}

export const propertiesSchema = z.record(z.unknown()).optional()
  .refine(val => !val || Object.keys(val).length <= MAX_PROPERTY_KEYS,
    { message: `Properties must have at most ${MAX_PROPERTY_KEYS} keys` })
  .refine(val => !val || Object.values(val).every(isValueWithinLimit),
    { message: `Each property value must be ≤ ${MAX_PROPERTY_VALUE_CHARS} chars when stringified` });
