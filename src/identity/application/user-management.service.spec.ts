import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RoleKey } from '../domain/role-key.enum';
import { UserStatus } from '../domain/user-status.enum';
import { RoleEntity } from '../infrastructure/persistence/role.entity';
import { UserAccountEntity } from '../infrastructure/persistence/user-account.entity';
import { PasswordHasherService } from './password-hasher.service';
import { UserManagementService } from './user-management.service';

describe('UserManagementService', () => {
  let service: UserManagementService;
  let userRepository: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let roleRepository: { find: jest.Mock };
  let passwordHasher: { hash: jest.Mock; verify: jest.Mock };

  const financeRole: Partial<RoleEntity> = {
    id: '2',
    key: RoleKey.FINANCE,
    name: 'Finance',
  };

  const savedUser: Partial<UserAccountEntity> = {
    id: '10',
    publicId: 'user-public-id',
    email: 'finance@test.com',
    displayName: 'Jane Finance',
    status: UserStatus.ACTIVE,
    roles: [financeRole as RoleEntity],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    userRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((input: unknown) => input),
      save: jest.fn(),
    };
    roleRepository = { find: jest.fn() };
    passwordHasher = { hash: jest.fn(), verify: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserManagementService,
        { provide: getRepositoryToken(UserAccountEntity), useValue: userRepository },
        { provide: getRepositoryToken(RoleEntity), useValue: roleRepository },
        { provide: PasswordHasherService, useValue: passwordHasher },
      ],
    }).compile();

    service = module.get(UserManagementService);
  });

  describe('createStaffUser', () => {
    it('throws a conflict when the email is already taken', async () => {
      userRepository.findOne.mockResolvedValueOnce({ id: 'existing' });

      await expect(
        service.createStaffUser({
          email: 'finance@test.com',
          password: 'password12345',
          displayName: 'Jane Finance',
          roles: [RoleKey.FINANCE],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws when a requested role does not exist', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      roleRepository.find.mockResolvedValueOnce([]); // none found

      await expect(
        service.createStaffUser({
          email: 'finance@test.com',
          password: 'password12345',
          displayName: 'Jane Finance',
          roles: [RoleKey.FINANCE],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates a partner-less, active staff user and returns the public shape', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      roleRepository.find.mockResolvedValueOnce([financeRole]);
      passwordHasher.hash.mockResolvedValueOnce('hashed-password');
      userRepository.save.mockResolvedValueOnce(savedUser);

      const result = await service.createStaffUser({
        email: 'finance@test.com',
        password: 'password12345',
        displayName: 'Jane Finance',
        roles: [RoleKey.FINANCE],
      });

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPartnerUser: false, partnerId: null }),
      );
      expect(result).toEqual({
        publicId: 'user-public-id',
        email: 'finance@test.com',
        displayName: 'Jane Finance',
        status: UserStatus.ACTIVE,
        roles: [RoleKey.FINANCE],
        createdAt: savedUser.createdAt,
      });
      // never leaks passwordHash or internal id
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('id');
    });
  });

  describe('getUserByPublicId', () => {
    it('throws NotFoundException for an unknown publicId', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.getUserByPublicId('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    it('disables an active user', async () => {
      userRepository.findOne.mockResolvedValueOnce({ ...savedUser });
      userRepository.save.mockResolvedValueOnce({
        ...savedUser,
        status: UserStatus.DISABLED,
      });

      const result = await service.updateStatus(
        'user-public-id',
        UserStatus.DISABLED,
      );
      expect(result.status).toBe(UserStatus.DISABLED);
    });
  });

  describe('updateRoles', () => {
    it('throws when any new role key is invalid', async () => {
      userRepository.findOne.mockResolvedValueOnce({ ...savedUser });
      roleRepository.find.mockResolvedValueOnce([]); // requested role not found

      await expect(
        service.updateRoles('user-public-id', [RoleKey.AUDITOR]),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
