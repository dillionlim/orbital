import { Module } from '@nestjs/common';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [SupabaseAuthGuard],
  exports: [SupabaseAuthGuard],
})
export class AuthModule {}
