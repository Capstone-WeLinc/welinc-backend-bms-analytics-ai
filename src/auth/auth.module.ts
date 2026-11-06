import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * Minimal auth wiring for the standalone analytics backend.
 * Only JWT *verification* is needed (no token signing), so there is no
 * JwtModule/AuthService/AuthController — the main BMS backend mints the tokens.
 */
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, JwtAuthGuard],
  exports: [JwtAuthGuard],
})
export default class AuthModule {}
