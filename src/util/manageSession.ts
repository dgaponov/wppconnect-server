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
import { callWebHook, startAllSessions, startSession } from './functions';
import getAllTokens from './getAllTokens';
import { SessionResourceMonitor } from './SessionResourceMonitor';
import { clientsArray, deleteSessionOnArray } from './sessionUtil';

type ExecResult = {
  output: string | undefined;
  error: string | null;
};

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
// RAM limit per session (Chromium tree, PSS). A session whose browser tree
// crosses this is leaking (runaway renderer / wedged WA-Web tab) and gets
// killed + revived by restartSession. PSS is the real per-session footprint
// (~500-900 MB healthy), so 1200 MB is well past normal noise.
const MEMORY_LIMIT_MB = 1200;
// Reuse one monitor instance across sweeps — its PID cache (5s) is pointless
// across the 10-min sweep interval, but a single instance avoids re-reading
// userDataDir / re-allocating state each pass.
const resourceMonitor = new SessionResourceMonitor(
  config.customUserDataDir || './userDataDir/',
  5000
);
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
// WA-level zombie detection. The screenshot probe only proves the browser
// page is alive — NOT that WhatsApp Web is actually authenticated. A session
// whose WA login expired server-side (phone offline too long / logged out /
// forced unpair) keeps status=CONNECTED and renders the "not logged in"
// screen, so it sails past the screenshot probe as "healthy" while being a
// non-functional zombie. We additionally probe client.isConnected()
// (WPP.conn.isLoggedIn) — true only when genuinely authenticated. Ride out
// transient WA reconnect blips by acting only after this many CONSECUTIVE
// down passes (10-min interval → ~20 min tolerance); a real zombie never
// recovers, a blip clears in seconds. Sessions flagged here go into the same
// probeFailed bucket, so the MAX_UNHEALTHY_FRACTION systemic-blip guard still
// suppresses a mass restart during a real WA outage.
const WA_PROBE_TIMEOUT_MS = 15000;
const WA_DOWN_STUCK_PASSES = 2;
// Stuck-load detector. A freshly-linked WA Web sometimes hangs on the full-screen
// "Logging out" spinner or an endless chat-loading spinner. The page is alive and
// isConnected() is true, so the watchdog above calls it healthy — yet the account is
// unusable. A dedicated, faster loop probes the DOM for the loaded chat-list pane; if a
// CONNECTED session still hasn't rendered it (or shows the "Logging out" screen) past a
// grace window, we drop it (logout + delete token + delete wedged profile) so the CRM
// can issue a fresh QR. See isWaLoaded / checkStuckLoadingSessions / dropSession below.
const STUCK_CHECK_INTERVAL_MS = 1000 * 60 * 2; // run the fast probe every 2 min
const STUCK_LOAD_GRACE_MS = 1000 * 60 * 4; // legit slow-load tolerance after CONNECTED
const STUCK_LOAD_WINDOW_MS = 1000 * 60 * 20; // only probe inside this post-connect window
const STUCK_LOAD_DROP_PASSES = 2; // consecutive stuck probes before dropping
const PROBE_EVAL_TIMEOUT_MS = 12000; // a wedged CDP evaluate hangs forever — bound it

let checkRunningSessionsTimeout: NodeJS.Timeout | null = null;
// consecutive CONNECTED passes each session has reported WA not-logged-in
// (isConnected() === false). Reset to 0 on any true reading or when the
// session leaves CONNECTED.
const waDownPasses = new Map<string, number>();
// consecutive passes each session has held its CURRENT skip-status. Keyed by
// session; entry is rewritten every sweep. Cleared whenever the session leaves
// the skip-statuses (CONNECTED/CLOSED/NONE) so the counter starts fresh next
// time it enters one.
const stuckPasses = new Map<string, { status: string; count: number }>();
// Single-flight guard: never let two sweeps run concurrently (they would race
// on pkill/startSession — one killing a browser the other just launched).
let isChecking = false;
// Stuck-load detector state. connectedAt: timestamp of the first fast-loop tick at
// which a session was seen CONNECTED (the start of its load window). stuckLoadPasses:
// consecutive DOM probes inside the window where WA Web hadn't finished loading.
let isStuckChecking = false;
const stuckLoadTimer: { current: NodeJS.Timeout | null } = { current: null };
const connectedAt = new Map<string, number>();
const stuckLoadPasses = new Map<string, number>();

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

/**
 * Tear down a session's browser for an in-flight launch retry (used by
 * createSessionUtil's backup fallback). Same safety contract as restartSession:
 * close → kill the whole Chromium tree for this profile → block until every
 * process is really gone → clear Singleton lockfiles. Relaunching over a live
 * or still-flushing Chromium on the same profile corrupts the LevelDB store,
 * so this MUST fully succeed before the caller restores a backup / re-runs
 * create() on the same userDataDir.
 */
export async function teardownSessionBrowser(
  session: string,
  profileDir: string
): Promise<void> {
  const client = clientsArray[session];
  if (client && client.status) {
    try {
      await withTimeout(client.close?.(), CLOSE_TIMEOUT_MS, `close ${session}`);
    } catch (error) {
      logger.error(`[LAUNCH-RETRY] Error/timeout closing ${session}: ${error}`);
    }
  }

  const killPattern = `[c]hromium.*${profileDir}([^0-9]|$)`;
  await killSessionBrowser(session, killPattern);

  // Profile is now free of live processes — drop stale lockfiles so the next
  // browser can reuse (or restore over) the userDataDir.
  safeExec(`rm -rf '${profileDir}/SingletonLock'`);
  safeExec(`rm -rf '${profileDir}/SingletonCookie'`);
  safeExec(`rm -rf '${profileDir}/SingletonSocket'`);
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
    const ramOver: string[] = []; // CONNECTED but over MEMORY_LIMIT_MB — always restart

    for (const session of names) {
      const client = clientsArray[session];
      const status = client?.status ?? 'NONE';

      if (client && status === 'CONNECTED') {
        probedConnected++;
        // Left a skip-status (or stayed healthy) — clear any stuck counter so a
        // future dip into INITIALIZING starts counting from 1 again.
        stuckPasses.delete(session);

        // RAM guard — checked BEFORE the screenshot probe so an over-limit
        // session is killed without also paying for a (likely wedged) probe.
        // A real per-session leak is never a host-wide blip, so ramOver bypasses
        // the MAX_UNHEALTHY_FRACTION guard that probeFailed is subject to below.
        try {
          const usage = await resourceMonitor.getSessionUsage(session);
          const memBytes = usage.chromium?.memory.bytes ?? 0;
          const memMb = memBytes / 1024 / 1024;
          if (memMb >= MEMORY_LIMIT_MB) {
            logger.error(
              `[SESSIONS-CHECK] ${session} using ${memMb.toFixed(0)} MB >= ` +
                `${MEMORY_LIMIT_MB} MB limit — killing and restarting`
            );
            ramOver.push(session);
            continue;
          }
        } catch (error) {
          // Don't let a measurement failure mask the probe — fall through.
          logger.error(
            `[SESSIONS-CHECK] Failed to measure RAM for ${session}: ${error}`
          );
        }

        // Probe 1 — browser page alive (catches a dead/wedged Chromium tab).
        try {
          await withTimeout(
            (client as any).waPage?.screenshot({
              type: 'png',
              encoding: 'base64',
            }),
            SCREENSHOT_TIMEOUT_MS,
            `screenshot ${session}`
          );
        } catch (error) {
          logger.error(
            `[SESSIONS-CHECK] Health probe failed for ${session} — ` +
              `browser likely dead/wedged: ${error}`
          );
          waDownPasses.delete(session);
          probeFailed.push(session);
          continue;
        }

        // Probe 2 — WhatsApp Web actually authenticated. A zombie (login
        // expired server-side) passes the screenshot probe but reports
        // isConnected() === false. Count consecutive downs to ride out a
        // transient WA reconnect blip before declaring the session dead.
        let waConnected = false;
        try {
          waConnected =
            (await withTimeout(
              (client as any).isConnected?.(),
              WA_PROBE_TIMEOUT_MS,
              `isConnected ${session}`
            )) ?? false;
        } catch (error) {
          logger.error(
            `[SESSIONS-CHECK] WA probe threw for ${session} — ` +
              `page wedged despite live screenshot: ${error}`
          );
          waDownPasses.delete(session);
          probeFailed.push(session);
          continue;
        }

        if (waConnected) {
          waDownPasses.delete(session);
          logger.info(`[SESSIONS-CHECK] ${session} healthy`);
        } else {
          const count = (waDownPasses.get(session) ?? 0) + 1;
          waDownPasses.set(session, count);
          if (count >= WA_DOWN_STUCK_PASSES) {
            logger.error(
              `[SESSIONS-CHECK] ${session} browser alive but WA not connected ` +
                `for ${count} passes (zombie) — restarting`
            );
            waDownPasses.delete(session);
            probeFailed.push(session);
          } else {
            logger.warn(
              `[SESSIONS-CHECK] ${session} WA not connected ` +
                `(count ${count}/${WA_DOWN_STUCK_PASSES}) — waiting to rule out blip`
            );
          }
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
    for (const key of waDownPasses.keys()) {
      if (!nameSet.has(key)) waDownPasses.delete(key);
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

    // RAM-kill bypasses the systemic-blip guard entirely: a single session
    // leaking past MEMORY_LIMIT_MB is a per-session defect, not a host spike,
    // and leaving it running risks an OOM that would take down every session.
    toRestart.push(...ramOver);

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

// Probe whether WA Web's app shell has finished loading. A freshly-linked session that
// hangs on the initial spinner OR the "Logging out" screen has NO conversation-list
// pane rendered, so hasChatList is false; the "Logging out" text is matched directly
// (multi-locale) as a strong positive signal. Returns loaded=false on any evaluate
// throw/timeout (a wedged page looks exactly like a stuck-loading page from here).
async function isWaLoaded(
  client: any
): Promise<{ loaded: boolean; loggingOut: boolean }> {
  let res: { hasChatList: boolean; loggingOut: boolean } | undefined;
  try {
    res = await withTimeout(
      client?.waPage?.evaluate(() => {
        const body = document.body?.innerText ?? '';
        const chatList =
          document.querySelector('[data-testid="chat-list"]') ||
          document.querySelector('#side aside'); // left-pane fallback
        return {
          hasChatList: !!chatList,
          // en / ru / es / pt-BR / fr — the fleet's WA Web locale isn't pinned.
          loggingOut: /logging out|выход|cerrando|sair|déconnexion/i.test(body),
        };
      }),
      PROBE_EVAL_TIMEOUT_MS,
      'stuck-load evaluate'
    );
  } catch (error) {
    // evaluate rejected (page navigating / detached) — treat as not-yet-loaded.
    logger.warn(`[STUCK-LOAD] probe threw: ${error}`);
  }
  if (!res) return { loaded: false, loggingOut: false };
  return { loaded: !!res.hasChatList, loggingOut: !!res.loggingOut };
}

// Drop a session: WA logout + kill its Chromium tree + delete token AND the wedged
// profile, then remove the client object and notify the CRM. Mirrors the
// logOutSession controller (controller/sessionController.ts) but needs no HTTP req.
// We deliberately do NOT call startSession afterwards — leaving the session deleted
// lets the CRM re-link via its normal logoutsession-triggered flow and avoids the
// known logout→start token-delete race (qrReadError).
async function dropSession(session: string, reason: string) {
  const client = clientsArray[session];
  logger.error(`[STUCK-LOAD] Dropping ${session}: ${reason}`);

  // 1. WA-level logout (best-effort — the page may be wedged).
  try {
    await withTimeout(
      (client as any)?.logout?.(),
      CLOSE_TIMEOUT_MS,
      `logout ${session}`
    );
  } catch (error) {
    logger.warn(`[STUCK-LOAD] logout threw for ${session}: ${error}`);
  }

  // 2. Kill ONLY this session's Chromium tree (reuse the watchdog's anchored pattern).
  if (config.customUserDataDir) {
    const dir = path.join(config.customUserDataDir, session);
    const killPattern = `[c]hromium.*${dir}([^0-9]|$)`;
    try {
      await killSessionBrowser(session, killPattern);
    } catch (error) {
      logger.warn(
        `[STUCK-LOAD] killSessionBrowser threw for ${session}: ${error}`
      );
    }
  }

  // 3. Delete token + wedged profile so the next link starts clean (fresh QR).
  // tokenStorePath is on config but not declared in ServerOptions — cast, mirroring
  // fileTokenStory.ts which reads the same value.
  const tokenFile = path.join(
    (config as any).tokenStorePath,
    `${session}.data.json`
  );
  const profileDir = path.join(config.customUserDataDir, session);
  for (const p of [tokenFile, profileDir]) {
    try {
      await fileSystem.promises.rm(p, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 1000,
      });
    } catch (error) {
      logger.warn(`[STUCK-LOAD] rm ${p} failed: ${error}`);
    }
  }

  // 4. Drop the client object (same reason restartSession deletes it — a stale
  // client with a dead `page` field poisons the next getClient() merge).
  deleteSessionOnArray(session);

  // 5. Notify CRM via the existing webhook path (build a minimal req-like so
  // callWebHook can read serverOptions + logger).
  try {
    await callWebHook(
      client,
      { serverOptions: config, logger } as any,
      'logoutsession',
      { message: `Session ${session} dropped: ${reason}`, connected: false }
    );
  } catch (error) {
    logger.warn(`[STUCK-LOAD] webhook failed for ${session}: ${error}`);
  }

  connectedAt.delete(session);
  stuckLoadPasses.delete(session);
}

// Fast loop: for each CONNECTED session inside its post-connect load window, probe the
// DOM; if WA Web still hasn't loaded (or is on the "Logging out" screen) for
// STUCK_LOAD_DROP_PASSES consecutive ticks, drop it. Single-flighted like the main
// watchdog so concurrent ticks can't double-drop.
async function checkStuckLoadingSessions() {
  if (isStuckChecking) {
    return;
  }
  isStuckChecking = true;
  try {
    for (const session of Object.keys(clientsArray)) {
      const client = clientsArray[session];
      if (!client || client.status !== 'CONNECTED') {
        connectedAt.delete(session);
        stuckLoadPasses.delete(session);
        continue;
      }

      // Record the first tick at which we saw this session CONNECTED — the start
      // of its load window.
      if (!connectedAt.has(session)) {
        connectedAt.set(session, Date.now());
      }
      const age = Date.now() - (connectedAt.get(session) ?? Date.now());

      // Too new → legit slow load, give it grace. Too old → long-healthy session,
      // skip (cheap false-positive insurance).
      if (age < STUCK_LOAD_GRACE_MS || age > STUCK_LOAD_WINDOW_MS) {
        continue;
      }

      const { loaded, loggingOut } = await isWaLoaded(client);
      if (loaded && !loggingOut) {
        stuckLoadPasses.delete(session);
        continue;
      }

      const reason = loggingOut ? 'logging-out screen' : 'chat list not loaded';
      const count = (stuckLoadPasses.get(session) ?? 0) + 1;
      stuckLoadPasses.set(session, count);
      if (count >= STUCK_LOAD_DROP_PASSES) {
        logger.warn(
          `[STUCK-LOAD] ${session} ${reason} (${count}/${STUCK_LOAD_DROP_PASSES}) — dropping`
        );
        try {
          await dropSession(session, reason);
        } catch (error) {
          logger.error(
            `[STUCK-LOAD] dropSession failed for ${session}: ${error}`
          );
        }
      } else {
        logger.warn(
          `[STUCK-LOAD] ${session} ${reason} (${count}/${STUCK_LOAD_DROP_PASSES})`
        );
      }
    }

    // Drop counters for sessions no longer present (logged out / migrated away).
    const live = new Set(Object.keys(clientsArray));
    for (const key of connectedAt.keys()) {
      if (!live.has(key)) connectedAt.delete(key);
    }
    for (const key of stuckLoadPasses.keys()) {
      if (!live.has(key)) stuckLoadPasses.delete(key);
    }
  } catch (error) {
    logger.error('[STUCK-LOAD] Unexpected error during sweep: ' + error);
  } finally {
    isStuckChecking = false;
    scheduleStuckCheck();
  }
}

export function scheduleStuckCheck() {
  if (stuckLoadTimer.current) clearTimeout(stuckLoadTimer.current);
  stuckLoadTimer.current = setTimeout(
    checkStuckLoadingSessions,
    STUCK_CHECK_INTERVAL_MS
  );
}
