import fs from 'fs';
import path from 'path';
import { CreateOptions } from '@wppconnect-team/wppconnect';

export class SessionBackupUtil {
  private clientId: string;
  private dataPath: string;
  private backupPath: string;
  private backupSync: NodeJS.Timeout | undefined;
  private backupSyncIntervalMs: number;
  private requiredDirs: string[];
  private rmMaxRetries: number;
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
    this.rmMaxRetries = 4;
    this.clientCreateOptions = clientCreateOptions;
  }

  async beforeBrowserInitialized() {
    await this.extractBackupSession();

    this.clientCreateOptions.puppeteerOptions = {
      ...this.clientCreateOptions.puppeteerOptions,
      userDataDir: this.userDataDir,
    };
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
    var self = this;
    this.backupSync = setInterval(async function () {
      await self.storeRemoteSession();
    }, this.backupSyncIntervalMs);
  }

  async storeRemoteSession() {
    const pathExists = await this.isValidPath(this.userDataDir);
    if (pathExists) {
      await fs.promises
        .cp(this.userDataDir as string, this.backupPath, { recursive: true })
        .catch(() => {});
      await this.deleteBackupMetadata();
    }
  }

  async extractBackupSession() {
    const sessionExists = await this.isValidPath(this.userDataDir);
    const backupExists = await this.isValidPath(this.backupPath);

    if (backupExists) {
      if (sessionExists) {
        await fs.promises
          .rm(this.userDataDir, {
            recursive: true,
            force: true,
            maxRetries: this.rmMaxRetries,
          })
          .catch(() => {});
      }

      await fs.promises
        .cp(this.backupPath, this.userDataDir, {
          recursive: true,
        })
        .catch(() => {});
    }
  }

  async deleteBackupSession() {
    const backupExists = await this.isValidPath(this.backupPath);
    if (backupExists) {
      await fs.promises
        .rm(this.backupPath, {
          recursive: true,
          force: true,
          maxRetries: this.rmMaxRetries,
        })
        .catch(() => {});
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
        if (!this.requiredDirs.includes(element)) {
          const dirElement = path.join(dir, element);
          const stats = await fs.promises.lstat(dirElement);

          if (stats.isDirectory()) {
            await fs.promises
              .rm(dirElement, {
                recursive: true,
                force: true,
                maxRetries: this.rmMaxRetries,
              })
              .catch(() => {});
          } else {
            await fs.promises.unlink(dirElement).catch(() => {});
          }
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
}
