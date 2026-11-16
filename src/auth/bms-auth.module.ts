import { Global, Module } from "@nestjs/common";
import { AuthVerifyModule } from "./verify";
import { AccountCheck } from "./account-check";
import { DirectoryClient } from "./directory.client";
@Global()
@Module({
  imports: [AuthVerifyModule],
  providers: [AccountCheck, DirectoryClient],
  exports: [AuthVerifyModule, AccountCheck, DirectoryClient],
})
export class BmsAuthModule {}
