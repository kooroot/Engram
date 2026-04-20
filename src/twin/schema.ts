import { z } from 'zod';

export const ExtractionItemKind = z.enum([
  'decision', 'preference', 'fact', 'insight', 'person', 'project_update',
]);

export const ExtractionLink = z.object({
  predicate: z.string().min(1).max(64),
  target_name: z.string().min(1).max(512),
});

export const ExtractionItem = z.object({
  kind: ExtractionItemKind,
  name: z.string().min(1).max(512),
  summary: z.string().min(1).max(2000),
  properties: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1),
  links: z.array(ExtractionLink),
});

export const ExtractionSchema = z.object({
  items: z.array(ExtractionItem).max(50),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractionItemT = z.infer<typeof ExtractionItem>;

export function validateExtraction(input: unknown): Extraction {
  return ExtractionSchema.parse(input);
}
