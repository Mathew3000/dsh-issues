/** Storage schema of one issue row (zod, as the storage domain expects). */
import { zod as z } from './harness.mjs'

const comment = z.object({
  at: z.string(),
  author: z.enum(['user', 'agent', 'system']),
  text: z.string(),
}).strict()

export const zodSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  project: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['open', 'in_progress', 'blocked', 'needs_review', 'done', 'cancelled']),
  priority: z.enum(['low', 'normal', 'high']),
  labels: z.array(z.string()),
  attempts: z.number().int().nonnegative(),
  failedStarts: z.number().int().nonnegative().default(0),
  sessionId: z.string().optional(),
  goalId: z.string().optional(),
  branch: z.string().optional(),
  worktreePath: z.string().optional(),
  blockedReason: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  comments: z.array(comment),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
