import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAgendaTable1676000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS agenda (
      id SERIAL PRIMARY KEY,
      cliente_nombre VARCHAR(255) NOT NULL,
      cliente_rut VARCHAR(20) NOT NULL,
      tecnico_nombre VARCHAR(255) NOT NULL,
      fecha_instalacion TIMESTAMP,
      estado INTEGER DEFAULT 1,
      fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS agenda;`);
  }
}
