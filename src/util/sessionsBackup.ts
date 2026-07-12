import { CreateOptions } from '@wppconnect-team/wppconnect';
import fs from 'fs';
import path from 'path';

export class SessionBackupUtil {
  /**
   * Chromium cache/resource dirs — not needed for session restoration.
   * Excluding them from the copy avoids the ENOTEMPTY errors on cleanup
   * and skips gigabytes of disposable data.
   */
  private static readonly SKIP_DIRS = new Set<string>([
    'Cache',
    'Code Cache',
    'GPUCache',
    'Service Worker',
    'GrShaderCache',
    'ShaderCache',
  ]);

  private clientId: string;
  private dataPath: string;
  private backupPath: string;
  private backupSync: NodeJS.Timeout | undefined;
  private backupSyncIntervalMs: number;
  private requiredDirs: string[];
  private userDataDir: string;
  private clientCreateOptions: CreateOptions;

  constructor({
    clientId,
    dataPath,
    clientCreateOptions,
  }: {
    clientId: string;
    dataPath: string;
    clientCreateOptions: CreateOptions;
  }) {
    this.clientId = clientId;
    this.backupSyncIntervalMs = 60000;
    this.dataPath = dataPath;
    this.userDataDir = path.join(this.dataPath, this.clientId);
    this.backupPath = path.join(dataPath, `backup_${this.clientId}`);
    this.requiredDirs = [
      'Default',
      'IndexedDB',
      'Local Storage',
    ]; /* => Required Files & Dirs in WWebJS to restore session */
    this.clientCreateOptions = clientCreateOptions;
  }

  async beforeBrowserInitialized() {
    await this.prepareLiveProfile();
    await this.applyUserDataDir();
  }

  async disconnect() {
    await this.deleteBackupSession();
    clearInterval(this.backupSync);
  }

  async afterAuthReady() {
    const sessionExists = await this.isValidPath(this.userDataDir);
    if (!sessionExists) {
      await this.delay(
        60000
      ); /* Initial delay sync required for session to be stable enough to recover */
      await this.storeRemoteSession();
    }
    this.backupSync = setInterval(async () => {
      await this.storeRemoteSession();
    }, this.backupSyncIntervalMs);
  }

  async storeRemoteSession() {
    const pathExists = await this.isValidPath(this.userDataDir);
    if (pathExists) {
      await fs.promises
        .cp(this.userDataDir as string, this.backupPath, {
          recursive: true,
          filter: (src) => !SessionBackupUtil.SKIP_DIRS.has(path.basename(src)),
        })
        .catch(() => {});
      await this.deleteBackupMetadata();
    }
  }

  /**
   * Prefer the live userDataDir — only create it (empty) when missing.
   * Never overwrite a live profile with the backup here: the backup is a
   * fallback, restored by restoreFromBackup() only if the live launch fails.
   * (Previously this clobbered a good live profile with a possibly-stale
   * backup on every start, so a server restart pulled in an expired session.)
   */
  async prepareLiveProfile() {
    const sessionExists = await this.isValidPath(this.userDataDir);
    if (!sessionExists) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
  }

  /**
   * Fall back to the backup: replace the live userDataDir with the backup
   * copy. Returns true if a backup was restored, false when there is no
   * backup to fall back to.
   */
  async hasBackup(): Promise<boolean> {
    return this.isValidPath(this.backupPath);
  }

  async restoreFromBackup(): Promise<boolean> {
    const backupExists = await this.isValidPath(this.backupPath);
    if (!backupExists) {
      return false;
    }

    await this.removePathSilently(this.userDataDir);
    await fs.promises
      .cp(this.backupPath, this.userDataDir, {
        recursive: true,
      })
      .catch(() => {});
    return this.isValidPath(this.userDataDir);
  }

  /**
   * Clear Singleton lockfiles and point puppeteerOptions at the (live or
   * restored) userDataDir. Shared by the first attempt and the backup retry.
   */
  async applyUserDataDir() {
    await this.removeSingletonFiles(this.userDataDir);

    this.clientCreateOptions.puppeteerOptions = {
      ...this.clientCreateOptions.puppeteerOptions,
      userDataDir: this.userDataDir,
    };
  }

  async deleteBackupSession() {
    const backupExists = await this.isValidPath(this.backupPath);
    if (backupExists) {
      await this.removePathSilently(this.backupPath);
    }
  }

  async deleteBackupMetadata() {
    const sessionDirs = [
      this.backupPath,
      path.join(this.backupPath, 'Default'),
    ];
    for (const dir of sessionDirs) {
      const sessionFiles = await fs.promises.readdir(dir);
      for (const element of sessionFiles) {
        if (this.requiredDirs.includes(element)) {
          continue;
        }
        const dirElement = path.join(dir, element);
        await this.removePathSilently(dirElement);
      }
      await this.removeSingletonFiles(dir);
    }
  }

  /**
   * Find in direction Singleton* files and try to remove it
   * Fix for SingletonLock and other files
   */
  async removeSingletonFiles(dir: string) {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      if (file.startsWith('Singleton')) {
        const filePath = path.join(dir, file);
        try {
          await this.removePathSilently(filePath);
        } catch (err) {
          console.error(err, `Error deleting: ${filePath}`);
        }
      }
    }
  }

  async isValidPath(path: string) {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async removePathSilently(path: string) {
    const exists = await this.isValidPath(path);
    if (!exists) {
      return;
    }

    try {
      await fs.promises.rm(path, {
        maxRetries: 4,
        recursive: true,
        force: true,
      });
    } catch (err) {
      console.error(err, `Error deleting: ${path}`);
    }
  }
}
