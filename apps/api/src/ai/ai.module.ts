import { Module } from '@nestjs/common'
import { AskAiController } from './ask-ai.controller.js'
import { ScopeGuardService } from './scope-guard.service.js'

/**
 * Everything the streaming Ask AI surface needs: the `/ai/chat`
 * + `/ai/chat/tool-confirm` controller and the scope-guard pre-flight
 * service it depends on. No Prisma module import — `ask-ai.controller.ts`
 * uses the shared `@clickroom/db` `prisma` singleton directly, same as
 * `flags-stream.controller.ts`.
 */
@Module({
  controllers: [AskAiController],
  providers: [ScopeGuardService],
})
export class AiModule {}
