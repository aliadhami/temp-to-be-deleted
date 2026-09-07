import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PasswordHasherService } from '../../identity/application/password-hasher.service';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { UserStatus } from '../../identity/domain/user-status.enum';
import { RoleEntity } from '../../identity/infrastructure/persistence/role.entity';
import { UserAccountEntity } from '../../identity/infrastructure/persistence/user-account.entity';
import { PartnerEntity } from '../persistence/partner.entity';

export interface CreatePartnerUserInput {
  email: string;
  password: string;
  displayName: string;
}

const toPartnerUserResponse = (user: UserAccountEntity) => ({
  publicId: user.publicId,
  email: user.email,
  displayName: user.displayName,
  status: user.status,
  createdAt: user.createdAt,
});

@Injectable()
export class PartnerUserService {
  constructor(
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
    @InjectRepository(UserAccountEntity)
    private readonly userRepository: Repository<UserAccountEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,
    private readonly passwordHasher: PasswordHasherService,
  ) {}

  async create(partnerPublicId: string, input: CreatePartnerUserInput) {
    const partner = await this.partnerRepository.findOne({
      where: { publicId: partnerPublicId },
    });
    if (!partner) throw new NotFoundException('Partner not found');

    const existing = await this.userRepository.findOne({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const partnerRole = await this.roleRepository.findOne({
      where: { key: RoleKey.PARTNER },
    });
    if (!partnerRole) {
      // Should be unreachable — PARTNER is one of the seeded roles — but fail loudly rather
      // than silently create a user with no role if the seed data is ever missing.
      throw new Error(
        'PARTNER role is not seeded — check the SeedRoles migration',
      );
    }

    const passwordHash = await this.passwordHasher.hash(input.password);

    const user = this.userRepository.create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      isPartnerUser: true,
      partnerId: partner.id,
      status: UserStatus.ACTIVE,
      roles: [partnerRole],
    });
    const saved = await this.userRepository.save(user);
    return toPartnerUserResponse(saved);
  }

  async list(partnerPublicId: string) {
    const partner = await this.partnerRepository.findOne({
      where: { publicId: partnerPublicId },
    });
    if (!partner) throw new NotFoundException('Partner not found');

    const users = await this.userRepository.find({
      where: { partnerId: partner.id },
      order: { createdAt: 'DESC' },
    });
    return users.map(toPartnerUserResponse);
  }
}
