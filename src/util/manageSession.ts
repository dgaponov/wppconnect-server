/*
 * Copyright 2023 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import archiver from 'archiver';
import { Request } from 'express';
import fileSystem from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { execSync } from 'child_process';

import { logger } from '..';
import config from '../config';
import { startAllSessions, startSession } from './functions';
import getAllTokens from './getAllTokens';
import { clientsArray } from './sessionUtil';

type ExecResult = {
  output: string | undefined;
  error: string | null;
};

const hasExecutionError = (result: ExecResult): boolean => !!result.error;

const safeExec = (command: string): ExecResult => {
  try {
    const result = execSync(command, { stdio: 'pipe' });
    996220445692;

    return {
      output: result.toString().trim(),
      error: null,
    };
  } catch (err) {
    const error = err as { stdout?: Buffer; stderr?: Buffer };
    const output = error.stdout?.toString().trim();
    const errorMessage = error.stderr?.toString().trim();

    return {
      output,
      error: errorMessage || output || 'Неизвестная ошибка',
    };
  }
};

export function backupSessions(req: Request): Promise<any> {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    await closeAllSessions(req);
    const output = fileSystem.createWriteStream(
      __dirname + '/../backupSessions.zip'
    );
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Sets the compression level.
    });
    archive.on('error', function (err) {
      reject(err);
      req.logger.error(err);
    });
    archive.pipe(output);
    archive.directory(__dirname + '/../../tokens', 'tokens');
    fileSystem.cpSync(
      config.customUserDataDir,
      __dirname + '/../../backupFolder',
      { force: true, recursive: true }
    );

    archive.directory(__dirname + '/../../backupFolder', 'userDataDir');
    archive.finalize();

    output.on('close', () => {
      fileSystem.rmSync(__dirname + '/../../backupFolder', { recursive: true });
      const myStream = fileSystem.createReadStream(
        __dirname + '/../backupSessions.zip'
      );
      myStream.pipe(req.res as any);
      myStream.on('end', () => {
        logger.info('Sessions successfully backuped. Restarting sessions...');
        startAllSessions(config, logger);
        req.res?.end();
      });
      myStream.on('error', function (err: any) {
        console.log(err);
        reject(err);
      });
    });
  });
}

export async function restoreSessions(
  req: Request,
  file: Express.Multer.File
): Promise<any> {
  if (!file?.mimetype?.includes('zip')) {
    throw new Error('Please, send zipped file');
  }
  const path = file.path;
  logger.info('Starting restore sessions...');
  await closeAllSessions(req);

  const extract = fileSystem
    .createReadStream(path)
    .pipe(unzipper.Extract({ path: './restore' }));
  extract.on('close', () => {
    try {
      fileSystem.cpSync(__dirname + '/../../restore/tokens', 'tokens', {
        force: true,
        recursive: true,
      });
    } catch (error) {
      logger.info("Folder 'tokens' not found.");
    }
    try {
      fileSystem.cpSync(
        __dirname + '/../../restore/userDataDir',
        config.customUserDataDir,
        {
          force: false,
          recursive: true,
        }
      );
    } catch (error) {
      logger.info("Folder 'userDataDir' not found.");
    }
    logger.info('Sessions successfully restored. Starting...');
    startAllSessions(config, logger);
  });

  return { success: true };
}

export async function closeAllSessions(req: Request) {
  const names = await getAllTokens(req);
  names.forEach(async (session: string) => {
    const client = clientsArray[session];
    try {
      if (client?.status) {
        logger.info('Stopping session: ' + session);
        await client.close();
      }
      delete clientsArray[session];
    } catch (error) {
      logger.error('Not was possible stop session: ' + session);
    }
  });
}

function sleep(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

let checkRunningSessionsTimeout: NodeJS.Timeout | null = null;

async function restartSession(session: string) {
  const client = clientsArray[session];

  logger.info('[SESSIONS-CHECK] Trying to restart session ' + session + '...');

  if (client && client.status) {
    try {
      await client.close?.();
    } catch (error) {
      logger.error(
        '[SESSIONS-CHECK] Error closing session ' + session + ': ' + error
      );
    }
    client.status = 'CLOSED';
  }

  if (config.customUserDataDir) {
    const sessionUserDataDir = path.join(config.customUserDataDir, session);

    // Kill all browsers with session user data dir
    try {
      const result = safeExec(`pkill -f ${sessionUserDataDir}`);
      logger.error('[SESSIONS-CHECK] Try killing browser result');
      console.log(result);
      logger.info(result);
    } catch (err) {
      logger.error('[SESSIONS-CHECK] Error killing browsers for ' + session);
      logger.error(err);
    }

    // Remove browser lockfile for remove conflicts with other playwright instance=
    safeExec(`rm -rf ${sessionUserDataDir}/SingletonLock`);
    safeExec(`rm -rf ${sessionUserDataDir}/SingletonCookie`);
    safeExec(`rm -rf ${sessionUserDataDir}/SingletonSocket`);
    logger.info('[SESSIONS-CHECK] Removed browser lockfiles for ' + session);
  }

  await startSession(config, session, logger);
  await sleep(10000);
}

async function safeRestartSessions() {
  const names = await getAllTokens();

  // close all sessions
  for (const session of names) {
    const client = clientsArray[session];
    try {
      if (client?.status) {
        logger.info('Stopping session: ' + session);
        await client.close();
      }
      delete clientsArray[session];
    } catch (error) {
      logger.error('Not was possible stop session: ' + session);
    }
  }

  // Kill process
  process.exit();
}

async function checkRunningSessions() {
  logger.info('[SESSIONS-CHECK] Checking running sessions...');
  const names = await getAllTokens();

  logger.info(
    '[SESSIONS-CHECK] Found ' + names.length + ' sessions in store...'
  );

  logger.info(`[SESSIONS-CHECK] Sessions: ${names.join(', ')}`);
  let restartsCount = 0;

  for (const session of names) {
    try {
      const client = clientsArray[session];

      if (client && client.status === 'CONNECTED') {
        try {
          await client.waPage.screenshot({
            type: 'png',
            encoding: 'base64',
          });
          await client.unblockContact(session);
        } catch (error) {
          logger.error(
            '[SESSIONS-CHECK] Error taking screenshot of session ' + session
          );
          logger.error(error);
          logger.error('[SESSIONS-CHECK] Need restart ' + session);
          restartsCount += 1;
          continue;
        }

        logger.info('[SESSIONS-CHECK] Session ' + session + ' is running');
        continue;
      }

      if (client && client.status === 'INITIALIZING') {
        logger.info(
          '[SESSIONS-CHECK] Session ' +
            session +
            ' is initializing very long. Try restarting session...'
        );

        restartsCount += 1;
        continue;
      }

      if (!client || !client.status || client.status === 'CLOSED') {
        logger.info(
          '[SESSIONS-CHECK] Session ' + session + ' is not running or closed'
        );
        restartsCount += 1;
        continue;
      }

      if (client && client.status) {
        logger.info(
          '[SESSIONS-CHECK] Session ' + session + ' is not connected'
        );
        restartsCount += 1;
        continue;
      }
    } catch (error) {
      logger.error('[SESSIONS-CHECK] Error checking session ' + session);
      logger.error(error);
    }
  }

  logger.info('[SESSIONS-CHECK] Completed checking running sessions');
  if (restartsCount) {
    logger.info('[SESSIONS-CHECK] Need restart ' + restartsCount + ' sessions');
    await safeRestartSessions();
  } else {
    scheduleCheckRunningSessions();
  }
}

export function scheduleCheckRunningSessions() {
  checkRunningSessionsTimeout = setTimeout(
    checkRunningSessions,
    1000 * 60 * 10
  );
}
