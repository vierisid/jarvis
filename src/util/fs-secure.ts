import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function secureDirectory(dirPath: string, mode: number = 0o700): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode });
  await chmod(dirPath, mode);
}

export async function secureParentDirectory(filePath: string, mode: number = 0o700): Promise<void> {
  const dir = dirname(filePath);
  if (dir === '.' || dir === '') return;
  await secureDirectory(dir, mode);
}

export async function chmodWithWarning(filePath: string, mode: number, label: string): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[${label}] Failed to chmod ${filePath} to ${mode.toString(8)}: ${message}`);
  }
}
