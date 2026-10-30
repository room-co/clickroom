import { z } from 'zod'

export const rangeKeySchema = z.enum(['24h', '7d', '14d', '30d'])

export const widgetLayoutSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
})

export const widgetsInputSchema = z.object({ projectId: z.string() })

export const addWidgetInputSchema = z.object({
  projectId: z.string(),
  insightId: z.string(),
  layout: widgetLayoutSchema.optional(),
})

export const updateLayoutInputSchema = z.object({
  projectId: z.string(),
  layouts: z.array(z.object({ id: z.string() }).merge(widgetLayoutSchema)),
})

export const updateWidgetInputSchema = z.object({
  projectId: z.string(),
  id: z.string(),
  rangeKey: rangeKeySchema.nullable().optional(),
})

export const removeWidgetInputSchema = z.object({
  projectId: z.string(),
  id: z.string(),
})
