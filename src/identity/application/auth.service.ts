import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserStatus } from '../domain/user-status.enum';
import { UserAccountEntity } from '../infrastructure/persistence/user-account.entity';
import { JwtPayload, RefreshTokenPayload } from '../domain/jwt-payload.model';
import { PasswordHasherService } from './password-hasher.service';
import { JwtSignOptions } from '@nestjs/jwt';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserAccountEntity)
    private readonly userRepository: Repository<UserAccountEntity>,
    private readonly passwordHasher: PasswordHasherService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(email: string, plainPassword: string): Promise<AuthTokens> {
    const user = await this.userRepository.findOne({
      where: { email },
      relations: { roles: true },
      select: {
        id: true,
        publicId: true,
        email: true,
        passwordHash: true,
        status: true,
        partnerId: true,
      },
      // passwordHash has select: false on the entity — must opt in explicitly here
      loadEagerRelations: false,
    });

    // Deliberately identical error for "no such user" and "wrong password" —
    // never reveal which one it was.
    const invalidCredentials = () =>
      new UnauthorizedException('Invalid email or password');

    if (!user) throw invalidCredentials();
    if (user.status !== UserStatus.ACTIVE) throw invalidCredentials();

    const passwordMatches = await this.passwordHasher.verify(
      user.passwordHash,
      plainPassword,
    );
    if (!passwordMatches) throw invalidCredentials();

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        refreshToken,
        { secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET') },
      );
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.userRepository.findOne({
      where: { publicId: payload.sub },
      relations: { roles: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return this.issueTokens(user);
  }

  private async issueTokens(user: UserAccountEntity): Promise<AuthTokens> {
    const roles = (user.roles ?? []).map((role) => role.key);

    const accessPayload: JwtPayload = {
      sub: user.publicId,
      email: user.email,
      roles,
      partnerId: user.partnerId,
    };
    const refreshPayload: RefreshTokenPayload = {
      sub: user.publicId,
      tokenType: 'refresh',
    };

    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.getOrThrow<string>(
        'JWT_ACCESS_TTL',
      ) as NonNullable<JwtSignOptions['expiresIn']>,
    });
    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.getOrThrow<string>(
        'JWT_REFRESH_TTL',
      ) as NonNullable<JwtSignOptions['expiresIn']>,
    });

    return { accessToken, refreshToken };
  }
}
