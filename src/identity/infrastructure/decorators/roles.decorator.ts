import { SetMetadata } from '@nestjs/common';
import { RoleKey } from '../../domain/role-key.enum';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: RoleKey[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
