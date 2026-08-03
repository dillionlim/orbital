import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  // Cheap liveness probe: no DB / network, just proves the process is up.
  // Used by Koyeb's health check and by the keep-alive pinger.
  @Get('health')
  getHealth(): { status: string; ts: number } {
    return { status: 'ok', ts: Date.now() };
  }
}
