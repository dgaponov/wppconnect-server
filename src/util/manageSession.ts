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
// Graceful-kill budget. After SIGTERM, Chromium keeps flushing IndexedDB /
// LevelDB to the profile for a few seconds. We MUST wait for every process in
// the tree to actually exit before removing lockfiles or launching a new
// browser on the same profile — two Chromium instances sharing one LevelDB
// corrupts it ("В браузере произошла ошибка базы данных → повторите привязку").
// Poll pgrep until the tree is gone; if it outlives the grace window, escalate
// to SIGKILL and wait again.
const KILL_POLL_MS = 500;
const KILL_GRACE_MS = 12000; // wait after SIGTERM before escalating to -9
const KILL_FORCE_MS = 5000; // wait after SIGKILL before giving up
// Systemic-blip guard: if more than this fraction of CONNECTED sessions look
// unhealthy in a SINGLE pass, it's almost certainly a host-wide spike (CPU/mem)
// or a WhatsApp Web outage — not real per-session death. Force-restarting them
// all would only trigger a Chromium OOM storm and can permanently delete tokens
// (a failed restart → qrReadError → token removed in createSessionUtil). In that
// case we do nothing this pass and wait for the next tick.
const MAX_UNHEALTHY_FRACTION = 0.5;
const MIN_SESSIONS_FOR_FRACTION_GUARD = 4;
// Statuses that mean "mid-lifecycle" — normally leave alone, since restarting
// would abort an in-progress QR/phone-code linking.
// EXCEPTION: INITIALIZING should NEVER last long — it's the transient internal
// state while the browser launches and WhatsApp Web loads (a few seconds, maybe
// a minute under load). A session that sits in INITIALIZING across multiple
// passes is hung (a wedged create() that withTimeout abandoned but couldn't
// kill). So INITIALIZING is skip-status-with-a-limit: after this many
// CONSECUTIVE passes stuck, treat it as dead and force a restart. Counts reset
// the moment the status changes (to CONNECTED/CLOSED/anything), so a genuine
// in-progress link is never interrupted. With CHECK_INTERVAL_MS=10min,
// 2 passes means we act after ~10-20min stuck — far beyond any legit init.
const SKIP_STATUSES = new Set(['QRCODE', 'PHONECODE', 'INITIALIZING']);
const INITIALIZING_STUCK_PASSES = 2;

let checkRunningSessionsTimeout: NodeJS.Timeout | null = null;
// consecutive passes each session has held its CURRENT skip-status. Keyed by
// session; entry is rewritten every sweep. Cleared whenever the session leaves
// the skip-statuses (CONNECTED/CLOSED/NONE) so the counter starts fresh next
// time it enters one.
const stuckPasses = new Map<string, { status: string; count: number }>();
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

// Count live processes whose cmdline matches the anchored profile pattern.
// Returns 0 on any pgrep failure (exit 1 = no matches, which is what we want).
function countSessionProcs(killPattern: string): number {
  const result = safeExec(`pgrep -f '${killPattern}' | wc -l`);
  const n = parseInt((result.output ?? '0').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// Kill this session's whole Chromium tree and BLOCK until every process is
// really gone. Sends SIGTERM, polls for exit up to KILL_GRACE_MS, then escalates
// to SIGKILL and polls up to KILL_FORCE_MS. Returns true if the tree is
// confirmed dead — callers must not touch lockfiles / relaunch unless it is,
// otherwise a still-flushing Chromium races the new one and corrupts LevelDB.
async function killSessionBrowser(
  session: string,
  killPattern: string
): Promise<boolean> {
  if (countSessionProcs(killPattern) === 0) return true;

  // SIGTERM — let Chromium flush and shut down cleanly.
  safeExec(`pkill -f '${killPattern}'`);

  const waitGone = async (budgetMs: number): Promise<boolean> => {
    let waited = 0;
    while (waited < budgetMs) {
      if (countSessionProcs(killPattern) === 0) return true;
      await sleep(KILL_POLL_MS);
      waited += KILL_POLL_MS;
    }
    return countSessionProcs(killPattern) === 0;
  };

  if (await waitGone(KILL_GRACE_MS)) {
    logger.info(`[SESSIONS-CHECK] ${session} browser exited cleanly (SIGTERM)`);
    return true;
  }

  // Still alive — escalate. -9 gives no chance to flush, but at this point the
  // process is wedged anyway and a corrupt-on-SIGKILL profile is no worse than a
  // hung one; the real corruption risk is two LIVE instances, which we avoid.
  logger.warn(
    `[SESSIONS-CHECK] ${session} browser survived SIGTERM — escalating to SIGKILL`
  );
  safeExec(`pkill -9 -f '${killPattern}'`);

  if (await waitGone(KILL_FORCE_MS)) {
    logger.info(`[SESSIONS-CHECK] ${session} browser killed (SIGKILL)`);
    return true;
  }

  logger.error(
    `[SESSIONS-CHECK] ${session} browser STILL alive after SIGKILL — ` +
      `refusing to relaunch (would corrupt the profile). Will retry next pass.`
  );
  return false;
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

  // Drop the stale client object before re-creating. createSessionUtil does
  // `Object.assign(wppClient, getClient(session))`, and the wppconnect client
  // stores its puppeteer Page as an own-enumerable `page` field (the `waPage`
  // getter returns `this.page`). If the OLD client lingers here, getClient()
  // returns it and Object.assign copies its DEAD `page` over the fresh
  // wppClient.page — so the restarted session reports CONNECTED (events are
  // bound to the new page via closures) while waPage/isConnected/screenshot
  // still hit the old dead page (-> "detached Frame" / "Session closed").
  // Clearing it forces getClient() to mint a clean {status, session}
  // placeholder, so only those harmless props get merged onto the new client.
  delete clientsArray[session];

  if (config.customUserDataDir) {
    const sessionUserDataDir = path.join(config.customUserDataDir, session);

    // Kill ONLY this session's browser tree. `pkill -f` is a substring/regex
    // match, so we anchor carefully:
    //  • `[c]hromium.*` — bracket trick: matches the literal string "chromium"
    //    in a real browser's cmdline, but pgrep/pkill's OWN cmdline contains the
    //    literal "[c]hromium" which the regex does NOT match. Without this the
    //    command self-matches, countSessionProcs never returns 0, and we'd force
    //    -SIGKILL + refuse-to-relaunch on every restart.
    //  • trailing `([^0-9]|$)` — non-digit/end boundary so a shorter id can't
    //    match a longer sibling (e.g. "79104617787" vs "791046177870").
    // Killing the main browser process reaps its renderer/gpu children.
    const killPattern = `[c]hromium.*${sessionUserDataDir}([^0-9]|$)`;

    // BLOCK until the old browser is confirmed dead. If it refuses to die, abort
    // the restart — relaunching over a live Chromium corrupts the LevelDB
    // profile and forces a re-link. Next sweep will try again.
    const dead = await killSessionBrowser(session, killPattern);
    if (!dead) {
      await sleep(RESTART_PACING_MS);
      return;
    }

    // Safe now — no live process holds the profile. Remove stale lockfiles so
    // the fresh browser can reuse it.
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

    // Pass 1 — categorize, mutate nothing.
    //  • CONNECTED        → probe with a screenshot; a dead/wedged page fails it.
    //  • CLOSED / none    → not running (e.g. browser launch timed out at boot);
    //                       should simply be (re)started.
    //  • QR/PHONECODE/INIT→ mid-lifecycle; restarting aborts linking, leave alone.
    let probedConnected = 0;
    const probeFailed: string[] = []; // CONNECTED but page dead — guarded below
    const notRunning: string[] = []; // CLOSED / none — always safe to (re)start

    for (const session of names) {
      const client = clientsArray[session];
      const status = client?.status ?? 'NONE';

      if (client && status === 'CONNECTED') {
        probedConnected++;
        // Left a skip-status (or stayed healthy) — clear any stuck counter so a
        // future dip into INITIALIZING starts counting from 1 again.
        stuckPasses.delete(session);
        try {
          await withTimeout(
            (client as any).waPage?.screenshot({
              type: 'png',
              encoding: 'base64',
            }),
            SCREENSHOT_TIMEOUT_MS,
            `screenshot ${session}`
          );
          logger.info(`[SESSIONS-CHECK] ${session} healthy`);
        } catch (error) {
          logger.error(
            `[SESSIONS-CHECK] Health probe failed for ${session} — ` +
              `browser likely dead/wedged: ${error}`
          );
          probeFailed.push(session);
        }
        continue;
      }

      if (SKIP_STATUSES.has(status)) {
        // Count consecutive passes in THIS status. Reset to 1 whenever the
        // status changed since last sweep (prev.status !== status).
        const prev = stuckPasses.get(session);
        const count = prev && prev.status === status ? prev.count + 1 : 1;
        stuckPasses.set(session, { status, count });

        // INITIALIZING is the only skip-status we ever force-restart: a real
        // init finishes in well under a minute, so `count` this high means the
        // browser/create() is wedged. QRCODE/PHONECODE wait for a human scan and
        // are left alone indefinitely.
        if (status === 'INITIALIZING' && count >= INITIALIZING_STUCK_PASSES) {
          logger.error(
            `[SESSIONS-CHECK] ${session} hung in INITIALIZING for ${count} ` +
              `passes — treating as dead, will restart`
          );
          notRunning.push(session);
          stuckPasses.delete(session); // restartSession will cycle the status
        } else {
          logger.info(
            `[SESSIONS-CHECK] Skipping ${session} (status=${status}` +
              (status === 'INITIALIZING'
                ? `, ${count}/${INITIALIZING_STUCK_PASSES} passes`
                : '') +
              ') — mid-lifecycle'
          );
        }
        continue;
      }

      // CLOSED / NONE / anything else — needs to be (re)started.
      stuckPasses.delete(session);
      notRunning.push(session);
    }

    // Drop counters for sessions no longer in the token store (token deleted /
    // migrated away) so the map can't grow unbounded over the process lifetime.
    const nameSet = new Set(names);
    for (const key of stuckPasses.keys()) {
      if (!nameSet.has(key)) stuckPasses.delete(key);
    }

    // Revive not-running sessions unconditionally (paced). This is what heals a
    // startup thundering-herd: browsers that timed out launching at boot come up
    // one at a time here instead of all at once.
    const toRestart = [...notRunning];

    // Systemic-blip guard applies ONLY to probe failures: if a large fraction of
    // CONNECTED sessions fail the probe at once it's almost certainly a host-wide
    // spike, not real per-session death — skip THOSE restarts (but still revive
    // the genuinely not-running ones above).
    if (
      probedConnected >= MIN_SESSIONS_FOR_FRACTION_GUARD &&
      probeFailed.length > probedConnected * MAX_UNHEALTHY_FRACTION
    ) {
      logger.error(
        `[SESSIONS-CHECK] ${probeFailed.length}/${probedConnected} connected ` +
          `sessions failed the probe at once — treating as a systemic blip and ` +
          `NOT restarting them this pass.`
      );
    } else {
      toRestart.push(...probeFailed);
    }

    // Pass 2 — restart the dead ones, paced and one at a time.
    if (toRestart.length === 0) {
      logger.info('[SESSIONS-CHECK] All sessions healthy / running.');
    } else {
      logger.info(
        `[SESSIONS-CHECK] Restarting ${toRestart.length} session(s): ` +
          toRestart.join(', ')
      );
      for (const session of toRestart) {
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
