import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGeonetActivatedToInstallationRequest1740900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`installation_requests\`
        ADD COLUMN \`geonetActivated\` tinyint(1) NULL DEFAULT 0,
        ADD COLUMN \`geonetClientId\` varchar(50) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`installation_requests\`
        DROP COLUMN \`geonetActivated\`,
        DROP COLUMN \`geonetClientId\`
    `);
  }
}
