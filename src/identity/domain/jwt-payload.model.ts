import { RoleKey } from './role-key.enum';

export interface JwtPayload {
  /** subject — user's public_id, never the internal bigint id */
  sub: string;
  email: string;
  roles: RoleKey[];
  partnerId: string | null;
}

export interface RefreshTokenPayload {
  sub: string;
  /** distinguishes refresh tokens from access tokens if ever verified against the wrong secret */
  tokenType: 'refresh';
}
