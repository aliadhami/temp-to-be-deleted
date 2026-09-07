import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './api/auth.controller';
import { AuthService } from './application/auth.service';
import { PasswordHasherService } from './application/password-hasher.service';
import { RoleEntity } from './infrastructure/persistence/role.entity';
import { UserAccountEntity } from './infrastructure/persistence/user-account.entity';
import { UsersController } from './api/users.controller';
import { UserManagementService } from './application/user-management.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserAccountEntity, RoleEntity]),
    JwtModule.register({}), // per-call secret/expiry passed explicitly in AuthService
  ],
  providers: [PasswordHasherService, AuthService, UserManagementService],
  controllers: [AuthController, UsersController],
  exports: [PasswordHasherService, TypeOrmModule],
})
export class IdentityModule {}
