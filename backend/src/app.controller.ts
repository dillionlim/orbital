import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Cheap liveness probe: no DB / network, just proves the process is up.
  // Used by Koyeb's health check and by the keep-alive pinger.
  @Get('health')
  getHealth(): { status: string; ts: number } {
    return { status: 'ok', ts: Date.now() };
  }
}
