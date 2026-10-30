import { REFRESH_TOKEN_COOKIE } from '@clickroom/auth'
import { z } from 'zod'
import {
  clearLegacyHostOnlyCookie,
  clearRefreshCookie,
  setRefreshCookie,
} from '../../lib/cookies.js'
import { authedProcedure, publicProcedure, router } from '../trpc.js'
import { assertFirstOwnerInTx, assertSignupsOpen, getSignupStatus } from './signup-gate.js'

export const authRouter = router({
  signupStatus: publicProcedure.query(({ ctx }) => getSignupStatus(ctx.prisma)),

  signup: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(8),
        orgName: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Pre-GA gate. SignupPage hides the form when this flag is on, but that is
      // cosmetic — this is a public procedure, so the check has to happen here
      // too. `acceptInvite` is deliberately NOT gated: invitees join an existing
      // workspace rather than creating one, and they are already vetted.
      await assertSignupsOpen(ctx.prisma, input.email)

      const result = await ctx.authService.signup(input, assertFirstOwnerInTx)
      setRefreshCookie(ctx.res, result.refreshToken)
      return { user: result.user, org: result.org, accessToken: result.accessToken }
    }),

  login: publicProcedure
    .input(z.object({ email: z.string().email(), password: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const result = await ctx.authService.login(input)
      setRefreshCookie(ctx.res, result.refreshToken)
      return { accessToken: result.accessToken, user: result.user, org: result.org }
    }),

  getInvite: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(({ input, ctx }) => ctx.authService.getInvite(input.token)),

  acceptInvite: publicProcedure
    .input(
      z.object({
        token: z.string(),
        name: z.string().min(1),
        password: z.string().min(8),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await ctx.authService.acceptInvite(input)
      setRefreshCookie(ctx.res, result.refreshToken)
      return { user: result.user, org: result.org, accessToken: result.accessToken }
    }),

  refresh: publicProcedure.mutation(async ({ ctx }) => {
    const rawToken = (ctx.req.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined) ?? ''
    try {
      const result = await ctx.authService.refresh(rawToken)
      setRefreshCookie(ctx.res, result.refreshToken)
      return { accessToken: result.accessToken, user: result.user, org: result.org }
    } catch (err) {
      // A rejected refresh is the ONE path that must still evict the legacy
      // host-only cookie (see lib/cookies.ts). It is the likeliest reason we got
      // here: the browser sent the stale twin instead of the live domain-scoped
      // cookie, so the selector matches no session. Without this, the user is
      // wedged — every cold load 401s on the twin, and the success paths that
      // would have evicted it are never reached.
      clearLegacyHostOnlyCookie(ctx.res)
      throw err
    }
  }),

  logout: authedProcedure.mutation(async ({ ctx }) => {
    await ctx.authService.logout(ctx.tokenPayload.sessionId)
    clearRefreshCookie(ctx.res)
    return { ok: true }
  }),

  me: authedProcedure.query(({ ctx }) =>
    ctx.authService.me(ctx.tokenPayload.sub, ctx.tokenPayload.orgId, ctx.tokenPayload.sessionId),
  ),
})
