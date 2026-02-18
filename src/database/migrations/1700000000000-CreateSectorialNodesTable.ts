import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSectorialNodesTable1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS sectorial_nodes (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(255) NOT NULL,
      tipo VARCHAR(255),
      ip VARCHAR(100),
      usuario VARCHAR(255),
      password VARCHAR(255),
      coordenadas VARCHAR(255),
      zona VARCHAR(255),
      total_clientes INT,
      ssid VARCHAR(255),
      frecuencias VARCHAR(255),
      nodo_torre VARCHAR(255),
      comentarios TEXT,
      falla_general VARCHAR(255),
      accion VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sectorial_nodes;`);
  }
}
