import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('sectorial_nodes')
export class SectorialNode {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  nombre!: string;
  @Column({ type: 'varchar', length: 255, nullable: true })
  tipo!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  usuario!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  password!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  coordenadas!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  zona!: string | null;

  @Column({ type: 'int', nullable: true })
  totalClientes!: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  ssid!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  frecuencias!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  nodoTorre!: string | null;

  @Column('text', { nullable: true })
  comentarios!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  fallaGeneral!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  accion!: string | null;
}
