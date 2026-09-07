import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { UserStatus } from '../domain/user-status.enum';
import { UserAccountEntity } from '../infrastructure/persistence/user-account.entity';
import { AuthService } from './auth.service';
import { PasswordHasherService } from './password-hasher.service';

describe('AuthService', () => {
  let authService: AuthService;
  let userRepository: jest.Mocked<
    Pick<Repository<UserAccountEntity>, 'findOne'>
  >;
  let passwordHasher: jest.Mocked<PasswordHasherService>;
  let jwtService: jest.Mocked<Pick<JwtService, 'signAsync' | 'verifyAsync'>>;
  let configService: { getOrThrow: jest.Mock };

  const activeUser: Partial<UserAccountEntity> = {
    id: '1',
    publicId: 'user-public-id',
    email: 'user@example.com',
    passwordHash: 'hashed-value',
    status: UserStatus.ACTIVE,
    partnerId: null,
    roles: [{ id: '1', key: 'ADMIN' as never, name: 'Administrator' }],
  };

  beforeEach(() => {
    userRepository = { findOne: jest.fn() };
    passwordHasher = { hash: jest.fn(), verify: jest.fn() } as never;
    jwtService = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    configService = { getOrThrow: jest.fn((key: string) => `mock-${key}`) };
    authService = new AuthService(
      userRepository as never,
      passwordHasher,
      jwtService as never,
      configService as never,
    );
  });

  describe('login', () => {
    it('throws the same message for a nonexistent user as for a wrong password', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        authService.login('missing@example.com', 'anything'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws for a disabled user even with the correct password', async () => {
      userRepository.findOne.mockResolvedValueOnce({
        ...activeUser,
        status: UserStatus.DISABLED,
      } as UserAccountEntity);

      await expect(
        authService.login('user@example.com', 'correct-password'),
      ).rejects.toThrow(UnauthorizedException);
      expect(passwordHasher.verify).not.toHaveBeenCalled();
    });

    it('throws when the password does not match', async () => {
      userRepository.findOne.mockResolvedValueOnce(
        activeUser as UserAccountEntity,
      );
      passwordHasher.verify.mockResolvedValueOnce(false);

      await expect(
        authService.login('user@example.com', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('issues an access and refresh token on valid credentials', async () => {
      userRepository.findOne.mockResolvedValueOnce(
        activeUser as UserAccountEntity,
      );
      passwordHasher.verify.mockResolvedValueOnce(true);
      jwtService.signAsync
        .mockResolvedValueOnce('mock-access-token')
        .mockResolvedValueOnce('mock-refresh-token');

      const tokens = await authService.login(
        'user@example.com',
        'correct-password',
      );

      expect(tokens).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      });
      expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
    });
  });

  describe('refresh', () => {
    it('throws when the refresh token fails verification', async () => {
      jwtService.verifyAsync.mockRejectedValueOnce(new Error('bad token'));
      await expect(authService.refresh('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws when the user behind a valid token no longer exists', async () => {
      jwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-public-id',
        tokenType: 'refresh',
      });
      userRepository.findOne.mockResolvedValueOnce(null);

      await expect(authService.refresh('valid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
