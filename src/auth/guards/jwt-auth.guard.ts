import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { AccountCheck } from "../account-check";
import { TOKEN_VERIFIER, TokenVerifier, checkPerson } from "../verify";
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly accounts: AccountCheck,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const { raw, token } = await checkPerson(this.verifier, req);
    const { user } = await this.accounts.confirm(raw, token);
    req.user = { ...user, roles: token.roles };
    return true;
  }
}
