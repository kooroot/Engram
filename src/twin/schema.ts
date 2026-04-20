import { z } from 'zod';

const trimmed = (min: number, max: number) =>
  z.string().trim().min(min).max(max);

export const ExtractionItemKind = z.enum([
  'decision', 'preference', 'fact', 'insight', 'person', 'project_update',
]);

export const ExtractionLink = z.object({
  predicate: trimmed(1, 64),
  target_name: trimmed(1, 512),
}).strict();

export const ExtractionItem = z.object({
  kind: ExtractionItemKind,
  name: trimmed(1, 512),
  summary: trimmed(1, 2000),
  properties: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  links: z.array(ExtractionLink).max(20),
}).strict();

export const ExtractionSchema = z.object({
  items: z.array(ExtractionItem).max(50),
}).strict();

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractionItemT = z.infer<typeof ExtractionItem>;

export function validateExtraction(input: unknown): Extraction {
  return ExtractionSchema.parse(input);
}
