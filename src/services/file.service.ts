import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export class FileService {
  private uploadsDir = path.join(__dirname, '../../uploads');
  private expirationDays = 30;

  constructor() {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
    this.cleanExpiredFiles();
  }

  public saveFile(buffer: Buffer, originalFileName: string): string {
    const fileExtension = path.extname(originalFileName);
    const fileName = `${randomUUID()}${fileExtension}`;
    const filePath = path.join(this.uploadsDir, fileName);

    fs.writeFileSync(filePath, buffer);
    return fileName;
  }

  public deleteFile(fileName: string): void {
    if (!fileName) return;
    const filePath = path.join(this.uploadsDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  public getFilePath(fileName: string): string {
    return path.join(this.uploadsDir, fileName);
  }

  private cleanExpiredFiles(): void {
    const files = fs.readdirSync(this.uploadsDir);
    const now = Date.now();
    const expirationTime = this.expirationDays * 24 * 60 * 60 * 1000;

    files.forEach((file) => {
      const filePath = path.join(this.uploadsDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      if (fileAge > expirationTime) {
        fs.unlinkSync(filePath);
        console.log(`Archivo eliminado: ${file}`);
      }
    });
  }
}