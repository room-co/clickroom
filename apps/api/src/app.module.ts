import { Module } from '@nestjs/common'
import { AiModule } from './ai/ai.module.js'
import { FlagsStreamController } from './flags/flags-stream.controller.js'
import { HealthController } from './health.controller.js'
import { McpModule } from './mcp/mcp.module.js'

@Module({
  imports: [McpModule, AiModule],
  controllers: [HealthController, FlagsStreamController],
})
export class AppModule {}
