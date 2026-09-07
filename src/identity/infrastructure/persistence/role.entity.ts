import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { RoleKey } from '../../domain/role-key.enum';

@Entity('role')
export class RoleEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ type: 'varchar', length: 40, unique: true })
  key!: RoleKey;

  @Column({ type: 'varchar', length: 80 })
  name!: string;
}
