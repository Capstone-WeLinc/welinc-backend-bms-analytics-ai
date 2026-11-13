import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/** Allows only BMS Administrators. Use after JwtAuthGuard, which sets request.user. */
@Injectable()
export class BmsAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: { roles?: { role: string; system: string }[] } }>().user;
    if (user?.roles?.some((item) => item.system === 'BMS' && item.role === 'ADMIN')) return true;
    throw new ForbiddenException('Only administrators can view this report.');
  }
}
