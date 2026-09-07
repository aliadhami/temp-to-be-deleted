import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  let service: PasswordHasherService;

  beforeEach(() => {
    service = new PasswordHasherService();
  });

  it('produces a hash that verifies against the original password', async () => {
    const hash = await service.hash('correct-horse-battery-staple');
    await expect(
      service.verify(hash, 'correct-horse-battery-staple'),
    ).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('correct-horse-battery-staple');
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    await expect(
      service.verify('not-a-valid-argon2-hash', 'anything'),
    ).resolves.toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const [hashA, hashB] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);
    expect(hashA).not.toEqual(hashB);
  });
});
