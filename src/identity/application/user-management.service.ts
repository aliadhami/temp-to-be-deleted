import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RoleKey } from '../domain/role-key.enum';
import { UserStatus } from '../domain/user-status.enum';
import { RoleEntity } from '../infrastructure/persistence/role.entity';
import { UserAccountEntity } from '../infrastructure/persistence/user-account.entity';
import { PasswordHasherService } from './password-hasher.service';
import { In, Repository } from 'typeorm';

export interface CreateStaffUserInput {
  email: string;
  password: string;
  displayName: string;
  roles: RoleKey[];
}

const toUserResponse = (user: UserAccountEntity) => ({
  publicId: user.publicId,
  email: user.email,
  displayName: user.displayName,
  status: user.status,
  roles: (user.roles ?? []).map((role) => role.key),
  createdAt: user.createdAt,
});

@Injectable()
export class UserManagementService {
  constructor(
    @InjectRepository(UserAccountEntity)
    private readonly userRepository: Repository<UserAccountEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,
    private readonly passwordHasher: PasswordHasherService,
  ) {}

  async createStaffUser(input: CreateStaffUserInput) {
    const existing = await this.userRepository.findOne({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const roles = await this.resolveRoles(input.roles);
    const passwordHash = await this.passwordHasher.hash(input.password);

    const user = this.userRepository.create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      isPartnerUser: false,
      partnerId: null,
      status: UserStatus.ACTIVE,
      roles,
    });
    const saved = await this.userRepository.save(user);
    return toUserResponse(saved);
  }

  async listUsers() {
    const users = await this.userRepository.find({
      relations: { roles: true },
      order: { createdAt: 'DESC' },
    });
    return users.map(toUserResponse);
  }

  async getUserByPublicId(publicId: string) {
    const user = await this.findByPublicIdOrThrow(publicId);
    return toUserResponse(user);
  }

  async updateStatus(publicId: string, status: UserStatus) {
    const user = await this.findByPublicIdOrThrow(publicId);
    user.status = status;
    const saved = await this.userRepository.save(user);
    return toUserResponse(saved);
  }

  async updateRoles(publicId: string, roleKeys: RoleKey[]) {
    const user = await this.findByPublicIdOrThrow(publicId);
    user.roles = await this.resolveRoles(roleKeys);
    const saved = await this.userRepository.save(user);
    return toUserResponse(saved);
  }

  private async findByPublicIdOrThrow(
    publicId: string,
  ): Promise<UserAccountEntity> {
    const user = await this.userRepository.findOne({
      where: { publicId },
      relations: { roles: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async resolveRoles(keys: RoleKey[]): Promise<RoleEntity[]> {
    const uniqueKeys = [...new Set(keys)];
    const roles = await this.roleRepository.find({
      where: { key: In(uniqueKeys) },
    });
    if (roles.length !== uniqueKeys.length) {
      throw new NotFoundException('One or more roles do not exist');
    }
    return roles;
  }
}
