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
import { execSync } from 'child_process';
import { Request } from 'express';
import fileSystem from 'fs';
import path from 'path';
import unzipper from 'unzipper';

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

const CHECK_INTERVAL_MS = 1000 * 60 * 10;
// Per-operation timeouts. A wedged Chromium tab makes CDP calls (screenshot,
// evaluate) hang FOREVER rather than throw. Without a timeout a single hung
// session would block the whole sequential sweep and the watchdog would never
// reschedule — i.e. the exact failure it exists to fix would silently kill it.
const SCREENSHOT_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 15000;
const START_TIMEOUT_MS = 90000;
const RESTART_PACING_MS = 10000;
// Systemic-blip guard: if more than this fraction of CONNECTED sessions look
// unhealthy in a SINGLE pass, it's almost certainly a host-wide spike (CPU/mem)
// or a WhatsApp Web outage — not real per-session death. Force-restarting them
// all would only trigger a Chromium OOM storm and can permanently delete tokens
// (a failed restart → qrReadError → token removed in createSessionUtil). In that
// case we do nothing this pass and wait for the next tick.
const MAX_UNHEALTHY_FRACTION = 0.5;
const MIN_SESSIONS_FOR_FRACTION_GUARD = 4;

let checkRunningSessionsTimeout: NodeJS.Timeout | null = null;
// Single-flight guard: never let two sweeps run concurrently (they would race
// on pkill/startSession — one killing a browser the other just launched).
let isChecking = false;

// Reject after `ms` if `promise` hasn't settled. The underlying promise is
// abandoned (a hung CDP call is left dangling), which is fine — we only care
// that the sweep keeps moving.
function withTimeout<T>(
  promise: Promise<T> | undefined,
  ms: number,
  label: string
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms: ${label}`)),
      ms
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function restartSession(session: string) {
  const client = clientsArray[session];

  logger.info('[SESSIONS-CHECK] Restarting session ' + session + '...');

  if (client && client.status) {
    try {
      await withTimeout(client.close?.(), CLOSE_TIMEOUT_MS, `close ${session}`);
    } catch (error) {
      logger.error(
        '[SESSIONS-CHECK] Error/timeout closing session ' +
          session +
          ': ' +
          error
      );
    }
    client.status = 'CLOSED';
  }

  if (config.customUserDataDir) {
    const sessionUserDataDir = path.join(config.customUserDataDir, session);

    // Kill ONLY this session's browser tree. `pkill -f` is a substring/regex
    // match, so a bare path would also match sibling sessions whose id has this
    // one as a prefix (e.g. "79104617787" matches "791046177870"). Anchor with a
    // non-digit-or-end boundary so only the exact profile path matches. Killing
    // the main browser process reaps its renderer/gpu children.
    const killPattern = `${sessionUserDataDir}([^0-9]|$)`;
    safeExec(`pkill -f '${killPattern}'`);

    // Remove browser lockfiles so the fresh browser can reuse the profile.
    safeExec(`rm -rf '${sessionUserDataDir}/SingletonLock'`);
    safeExec(`rm -rf '${sessionUserDataDir}/SingletonCookie'`);
    safeExec(`rm -rf '${sessionUserDataDir}/SingletonSocket'`);
    logger.info(
      '[SESSIONS-CHECK] Killed browser + cleared lockfiles for ' + session
    );
  }

  try {
    await withTimeout(
      startSession(config, session, logger),
      START_TIMEOUT_MS,
      `start ${session}`
    );
  } catch (error) {
    logger.error(
      '[SESSIONS-CHECK] Error/timeout starting session ' +
        session +
        ': ' +
        error
    );
  }

  // Pace restarts so a batch of dead sessions doesn't spawn a Chromium
  // thundering herd all at once.
  await sleep(RESTART_PACING_MS);
}

async function checkRunningSessions() {
  // If a previous sweep is still in flight, skip this tick. The in-flight sweep
  // reschedules itself in its finally block, so the chain is never broken.
  if (isChecking) {
    logger.warn(
      '[SESSIONS-CHECK] Previous sweep still running — skipping this tick.'
    );
    return;
  }
  isChecking = true;

  try {
    // getAllTokens swallows store errors and returns undefined; default to [] so
    // a transient store hiccup can't crash the sweep (and kill the watchdog).
    const names = (await getAllTokens()) || [];

    logger.info(
      `[SESSIONS-CHECK] Checking ${names.length} sessions: ${names.join(', ')}`
    );

    // Pass 1 — probe only, mutate nothing. Only CONNECTED sessions are
    // candidates: QR / PHONECODE / INITIALIZING sessions are mid-lifecycle, and
    // restarting them aborts linking and can end in qrReadError → token deleted.
    let probed = 0;
    const unhealthy: string[] = [];

    for (const session of names) {
      const client = clientsArray[session];

      if (!client || client.status !== 'CONNECTED') {
        logger.info(
          `[SESSIONS-CHECK] Skipping ${session} (status=${
            client?.status ?? 'none'
          })`
        );
        continue;
      }

      probed++;
      try {
        await withTimeout(
          client.waPage?.screenshot({ type: 'png', encoding: 'base64' }),
          SCREENSHOT_TIMEOUT_MS,
          `screenshot ${session}`
        );
        logger.info(`[SESSIONS-CHECK] ${session} healthy`);
      } catch (error) {
        logger.error(
          `[SESSIONS-CHECK] Health probe failed for ${session} — ` +
            `browser likely dead/wedged: ${error}`
        );
        unhealthy.push(session);
      }
    }

    // Systemic-blip guard — see MAX_UNHEALTHY_FRACTION above.
    if (
      probed >= MIN_SESSIONS_FOR_FRACTION_GUARD &&
      unhealthy.length > probed * MAX_UNHEALTHY_FRACTION
    ) {
      logger.error(
        `[SESSIONS-CHECK] ${unhealthy.length}/${probed} connected sessions look ` +
          `unhealthy at once — treating as a systemic blip and skipping ` +
          `restarts this pass.`
      );
      return;
    }

    // Pass 2 — restart only the genuinely-dead ones, paced and one at a time.
    if (unhealthy.length === 0) {
      logger.info('[SESSIONS-CHECK] All connected sessions healthy.');
    } else {
      logger.info(
        `[SESSIONS-CHECK] Restarting ${unhealthy.length} dead session(s): ` +
          unhealthy.join(', ')
      );
      for (const session of unhealthy) {
        try {
          await restartSession(session);
        } catch (error) {
          logger.error(
            `[SESSIONS-CHECK] Failed to restart ${session}: ${error}`
          );
        }
      }
    }
  } catch (error) {
    logger.error('[SESSIONS-CHECK] Unexpected error during sweep: ' + error);
  } finally {
    isChecking = false;
    scheduleCheckRunningSessions();
  }
}

export function scheduleCheckRunningSessions() {
  if (checkRunningSessionsTimeout) clearTimeout(checkRunningSessionsTimeout);
  checkRunningSessionsTimeout = setTimeout(
    checkRunningSessions,
    CHECK_INTERVAL_MS
  );
}
