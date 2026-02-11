import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('agenda')
export class Agenda {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'cliente_nombre', type: 'varchar', length: 255 })
  clienteNombre!: string;

  @Column({ name: 'cliente_rut', type: 'varchar', length: 20 })
  clienteRut!: string;

  @Column({ name: 'tecnico_nombre', type: 'varchar', length: 255 })
  tecnicoNombre!: string;

  @Column({ name: 'fecha_instalacion', type: 'timestamp', nullable: true })
  fechaInstalacion!: Date | null;

  @Column({ name: 'estado', type: 'int', default: 1 })
  estado!: number;

  @Column({ name: 'fecha_creacion', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  fechaCreacion!: Date;
}
