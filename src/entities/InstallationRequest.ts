import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('installation_requests')
export class InstallationRequest {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @Column({ unique: true })
  ci!: string;

  @Column()
  email!: string;

  @Column()
  address!: string;

  @Column({ nullable: true })
  coordinates!: string | null;

  @Column({ nullable: true })
  neighborhood!: string | null;

  @Column({ nullable: true })
  city!: string | null;

  @Column({ nullable: true })
  postalCode!: string | null;

  @Column({ nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  additionalPhone!: string | null;

  @Column('text')
  comments!: string;

  @Column('simple-array', { nullable: true })
  installationDates!: string[] | null;

  @Column({ nullable: true })
  timeFrom!: string | null;

  @Column({ nullable: true })
  timeTo!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idFront!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idBack!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addressProof!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  coupon!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  plan!: string | null;

  // Campos adicionales para confirmación del técnico
  @Column({ type: 'boolean' })
  confirmedByTechnician!: boolean;

  @Column({ nullable: true, type: 'datetime' })
  agreedInstallationDate!: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  agreedTimeFrom!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  agreedTimeTo!: string | null;

  @Column({ type: 'text', nullable: true })
  technicianNotes!: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}