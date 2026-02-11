import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('installation_requests')
export class InstallationRequest {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @Column()
  ci!: string;

  @Column()
  email!: string;

  @Column()
  address!: string;

  @Column()
  coordinates!: string;

  @Column()
  neighborhood!: string;

  @Column()
  city!: string;

  @Column()
  postalCode!: string;

  @Column()
  phone!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  additionalPhone!: string | null;

  @Column('text')
  comments!: string;

  @Column('simple-array')
  installationDates!: string[];

  @Column()
  timeFrom!: string;

  @Column()
  timeTo!: string;

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
  @Column({ type: 'boolean', nullable: true })
  confirmedByTechnician!: boolean | null;

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