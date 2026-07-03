/*
 * Copyright 2021 WPPConnect Team
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

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import pidusage from 'pidusage';
import { promisify } from 'util';

const execPromise = promisify(exec);

interface ProcessUsage {
  cpu: number;
  memory: number;
  count: number;
  processes: number[];
}

interface SessionUsageResult {
  sessionName: string;
  status: 'running' | 'not_running';
  message?: string;
  chromium?: {
    processCount: number;
    pids: number[];
    cpu: {
      percentage: string;
      raw: number;
    };
    memory: {
      mb: string;
      gb: string;
      bytes: number;
    };
  };
  timestamp: string;
}

interface AllSessionsUsageResult {
  sessions: SessionUsageResult[];
  summary: {
    totalSessions: number;
    runningSessions: number;
    totalCpu: string;
    totalMemory: string;
  };
}

interface CacheEntry {
  pids: number[];
  timestamp: number;
}

/**
 * SessionResourceMonitor - Monitors resource usage of Chromium processes for each session
 *
 * This class provides functionality to track CPU and memory usage of individual
 * WhatsApp sessions by monitoring their associated Chromium browser processes.
 */
export class SessionResourceMonitor {
  private cache: Map<string, CacheEntry>;
  private cacheDuration: number;
  private customUserDataDir: string;

  constructor(
    customUserDataDir: string = './userDataDir/',
    cacheDuration: number = 5000
  ) {
    this.cache = new Map();
    this.cacheDuration = cacheDuration; // 5 seconds default
    this.customUserDataDir = customUserDataDir;
  }

  /**
   * Find all Chromium process PIDs associated with a session
   * @param sessionName - The name of the session
   * @returns Array of process IDs
   */
  private async findSessionProcesses(sessionName: string): Promise<number[]> {
    try {
      // Determine platform
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        // Windows command to find Chrome processes by userDataDir
        const { stdout } = await execPromise(
          `wmic process where "commandline like '%${sessionName}%' and name='chrome.exe'" get processid`
        );

        const pids = stdout
          .split('\n')
          .slice(1) // Skip header
          .map((line) => parseInt(line.trim()))
          .filter((pid) => !isNaN(pid));

        return pids;
      } else {
        // Linux/Mac. Match the session's profile path anchored to a
        // non-digit-or-end boundary so a shorter session id can't match a
        // longer sibling (e.g. "79675556529" must not match "79675556025").
        // The [c]hromium bracket trick keeps the grep process from matching its
        // own command line. See manageSession.ts for the same reasoning.
        const profilePath = path.join(this.customUserDataDir, sessionName);
        const { stdout } = await execPromise(
          `ps -eo pid,args | grep -E "[c]hromium.*${profilePath}([^0-9]|$)" || true`
        );

        if (!stdout.trim()) {
          return [];
        }

        const lines = stdout
          .trim()
          .split('\n')
          .filter((l) => l);
        const pids = lines
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return parseInt(parts[0]); // PID is first column (ps -eo pid,args)
          })
          .filter((pid) => !isNaN(pid));

        return pids;
      }
    } catch (error) {
      // Session not running or error occurred
      return [];
    }
  }

  /**
   * Find session processes with caching to reduce system calls
   * @param sessionName - The name of the session
   * @returns Array of process IDs
   */
  private async findSessionProcessesCached(
    sessionName: string
  ): Promise<number[]> {
    const cached = this.cache.get(sessionName);
    const now = Date.now();

    // Use cache if still valid
    if (cached && now - cached.timestamp < this.cacheDuration) {
      return cached.pids;
    }

    // Cache expired or doesn't exist, fetch new data
    const pids = await this.findSessionProcesses(sessionName);
    this.cache.set(sessionName, { pids, timestamp: now });

    return pids;
  }

  /**
   * Get resource usage for multiple PIDs
   * @param pids - Array of process IDs
   * @returns Aggregated CPU and memory usage
   */
  private async getProcessesUsage(pids: number[]): Promise<ProcessUsage> {
    if (!pids || pids.length === 0) {
      return { cpu: 0, memory: 0, count: 0, processes: [] };
    }

    try {
      const stats = await pidusage(pids);

      let totalCpu = 0;

      // CPU is safe to sum across processes (no sharing between them).
      for (const pid of pids) {
        if (stats[pid]) {
          totalCpu += stats[pid].cpu;
        }
      }

      // Memory must NOT be a plain sum of per-process RSS. Chromium spawns ~10
      // processes (main + renderers + gpu + utility) that share large regions
      // (mapped libraries, shared memory between main and renderers). Each
      // process's RSS counts those shared pages in full, so summing RSS over the
      // tree double-counts shared memory up to Nx — it reported ~1.3-1.9 GB per
      // session, more than the whole 8 GB host across sessions. Use PSS
      // (proportional set size) instead: each process is charged only its share
      // of shared pages, so summing PSS across the tree is correct and matches
      // real container usage (~500-900 MB/session). Falls back to the pidusage
      // RSS sum where /proc/<pid>/smaps_rollup isn't available (non-Linux, perms).
      const totalMemory = await this.getTreeMemoryBytes(pids, stats);

      return {
        cpu: totalCpu,
        memory: totalMemory,
        count: pids.length,
        processes: pids,
      };
    } catch (error) {
      console.error('Error getting process usage:', error);
      return { cpu: 0, memory: 0, count: 0, processes: [] };
    }
  }

  /**
   * Sum real memory of a process tree via PSS (Linux /proc/<pid>/smaps_rollup).
   * PSS divides each shared page by the number of processes mapping it, so
   * summing PSS across a Chromium tree avoids the RSS double-counting problem.
   * Returns bytes. Falls back to the pidusage RSS sum if PSS can't be read
   * (e.g. non-Linux, or the process died between the pidusage call and here).
   *
   * @param pids - process IDs of the tree
   * @param stats - pidusage stats keyed by pid (RSS fallback source)
   * @returns total memory in bytes
   */
  private async getTreeMemoryBytes(
    pids: number[],
    stats: { [pid: number]: { memory: number } }
  ): Promise<number> {
    if (process.platform !== 'linux') {
      // No smaps_rollup off Linux — fall back to RSS sum.
      return pids.reduce((sum, pid) => sum + (stats[pid]?.memory ?? 0), 0);
    }

    let pssKb = 0;
    let readAny = false;

    await Promise.all(
      pids.map(async (pid) => {
        try {
          const rollup = await fs.promises.readFile(
            `/proc/${pid}/smaps_rollup`,
            'utf8'
          );
          // Line looks like: "Pss:                1234 kB"
          const match = rollup.match(/^Pss:\s+(\d+)\s+kB/m);
          if (match) {
            pssKb += parseInt(match[1], 10);
            readAny = true;
          }
        } catch {
          // Process gone or no smaps_rollup — skip; RSS fallback covers total.
        }
      })
    );

    if (!readAny) {
      // Couldn't read PSS for anything — fall back to RSS sum.
      return pids.reduce((sum, pid) => sum + (stats[pid]?.memory ?? 0), 0);
    }

    return pssKb * 1024;
  }

  /**
   * Get resource usage for a specific session
   * @param sessionName - The name of the session
   * @returns Session usage information
   */
  public async getSessionUsage(
    sessionName: string
  ): Promise<SessionUsageResult> {
    const pids = await this.findSessionProcessesCached(sessionName);

    if (pids.length === 0) {
      return {
        sessionName,
        status: 'not_running',
        message: 'No Chromium processes found for this session',
        timestamp: new Date().toISOString(),
      };
    }

    const usage = await this.getProcessesUsage(pids);

    return {
      sessionName,
      status: 'running',
      chromium: {
        processCount: usage.count,
        pids: usage.processes,
        cpu: {
          percentage: `${usage.cpu.toFixed(2)}%`,
          raw: usage.cpu,
        },
        memory: {
          mb: `${(usage.memory / 1024 / 1024).toFixed(2)} MB`,
          gb: `${(usage.memory / 1024 / 1024 / 1024).toFixed(3)} GB`,
          bytes: usage.memory,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get resource usage for all sessions
   * @returns Usage information for all sessions with summary
   */
  public async getAllSessionsUsage(): Promise<AllSessionsUsageResult> {
    try {
      // Get all session directories
      const sessionNames = await this.getSessionNames();

      const results: SessionUsageResult[] = [];
      let totalCpu = 0;
      let totalMemory = 0;

      for (const sessionName of sessionNames) {
        const usage = await this.getSessionUsage(sessionName);
        if (usage.status === 'running' && usage.chromium) {
          results.push(usage);
          totalCpu += usage.chromium.cpu.raw;
          totalMemory += usage.chromium.memory.bytes;
        }
      }

      return {
        sessions: results,
        summary: {
          totalSessions: sessionNames.length,
          runningSessions: results.length,
          totalCpu: `${totalCpu.toFixed(2)}%`,
          totalMemory: `${(totalMemory / 1024 / 1024).toFixed(2)} MB`,
        },
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get all session names from userDataDir
   * @returns Array of session names
   */
  private async getSessionNames(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.customUserDataDir)) {
        return [];
      }

      const files = fs.readdirSync(this.customUserDataDir);

      // Filter only directories (sessions)
      return files.filter((file) => {
        const fullPath = path.join(this.customUserDataDir, file);
        return fs.statSync(fullPath).isDirectory();
      });
    } catch (error) {
      console.error('Error reading session directories:', error);
      return [];
    }
  }

  /**
   * Clear the PIDs cache
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear cache for a specific session
   * @param sessionName - The name of the session
   */
  public clearSessionCache(sessionName: string): void {
    this.cache.delete(sessionName);
  }
}
