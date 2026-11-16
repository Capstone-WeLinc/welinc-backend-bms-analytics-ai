import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  DIRECTORY_TOKENS,
  ServiceTokenClient,
  VERIFY_CONFIG,
  type VerifyConfig,
} from "./verify";
export type DirectoryPerson = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  temporaryRoles?: string[];
  isActive: boolean;
  deleted: boolean;
  erased?: boolean;
};
@Injectable()
export class DirectoryClient {
  constructor(
    @Inject(DIRECTORY_TOKENS) private readonly tokens: ServiceTokenClient,
    @Inject(VERIFY_CONFIG) private readonly config: VerifyConfig,
  ) {}
  async lookup(ids: string[]): Promise<Map<string, DirectoryPerson>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const people = new Map<string, DirectoryPerson>();
    for (let i = 0; i < unique.length; i += 100) {
      const answer = await this.tokens.withToken(async (token) => {
        let res: Response;
        try {
          res = await fetch(
            `${this.config.internalUrl}/auth/directory/users/lookup`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ ids: unique.slice(i, i + 100) }),
              signal: AbortSignal.timeout(3000),
            },
          );
        } catch {
          throw new ServiceUnavailableException({
            code: "AUTH_UNAVAILABLE",
            message: "Directory unavailable",
          });
        }
        if (res.status === 401)
          throw new HttpException("Directory token expired", 401);
        if (!res.ok)
          throw new ServiceUnavailableException({
            code: "AUTH_UNAVAILABLE",
            message: "Directory unavailable",
          });
        return (await res.json()) as {
          users: DirectoryPerson[];
          missing: string[];
        };
      });
      if (!Array.isArray(answer.users))
        throw new ServiceUnavailableException("Directory answer is invalid");
      for (const person of answer.users) people.set(person.id, person);
    }
    return people;
  }
}
