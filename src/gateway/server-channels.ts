import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  getLoadedChannelPluginOrigin,
  listChannelPlugins,
} from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startChannelApprovalHandlerBootstrap } from "../infra/approval-handler-bootstrap.js";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { createTaskScopedChannelRuntime } from "../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
export type { ChannelRuntimeSnapshot };

const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTART_ATTEMPTS = 10;
const CHANNEL_STOP_ABORT_TIMEOUT_MS = 5_000;
const CHANNEL_STARTUP_CONCURRENCY = 4;

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  starting: Map<string, Promise<void>>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

type HealthMonitorConfig = {
  healthMonitor?: {
    enabled?: boolean;
  };
};

type ChannelHealthMonitorConfig = HealthMonitorConfig & {
  accounts?: Record<string, HealthMonitorConfig>;
};

type GatewayStartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    starting: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
}

async function waitForChannelStopGracefully(task: Promise<unknown> | undefined, timeoutMs: number) {
  if (!task) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    timer.unref?.();
    const resolveSettled = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    void task.then(resolveSettled, resolveSettled);
  });
}

function applyDescribedAccountFields(
  next: ChannelAccountSnapshot,
  described: ChannelAccountSnapshot | undefined,
) {
  if (!described) {
    next.configured ??= true;
    return next;
  }
  if (typeof described.configured === "boolean") {
    next.configured = described.configured;
  } else {
    next.configured ??= true;
  }
  if (described.mode !== undefined) {
    next.mode = described.mode;
  }
  return next;
}

type ChannelManagerOptions = {
  getRuntimeConfig: () => OpenClawConfig;
  channelLogs: Partial<Record<ChannelId, SubsystemLogger>>;
  channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>>;
  /**
   * Optional channel runtime helpers for external channel plugins.
   *
   * When provided, this value is passed to all channel plugins via the
   * `channelRuntime` field in `ChannelGatewayContext`, enabling external
   * plugins to access advanced Plugin SDK features (AI dispatch, routing,
   * text processing, etc.).
   *
   * Bundled channels typically don't use this because they can directly
   * import internal modules from the monorepo.
   *
   * This field is optional - omitting it maintains backward compatibility
   * with existing channels. When provided, it must be a real
   * `createPluginRuntime().channel` surface; partial stubs are not supported.
   *
   * @example
   * ```typescript
   * import { createPluginRuntime } from "../plugins/runtime/index.js";
   *
   * const channelManager = createChannelManager({
   *   getRuntimeConfig,
   *   channelLogs,
   *   channelRuntimeEnvs,
   *   channelRuntime: createPluginRuntime().channel,
   * });
   * ```
   *
   * @since Plugin SDK 2026.2.19
   * @see {@link ChannelGatewayContext.channelRuntime}
   */
  channelRuntime?: ChannelRuntimeSurface;
  /**
   * Lazily resolves optional channel runtime helpers for external channel plugins.
   *
   * Use this when the caller wants to avoid instantiating the full plugin channel
   * runtime during gateway startup. The manager only needs the runtime surface once
   * a channel account actually starts. The resolved value must be a real
   * `createPluginRuntime().channel` surface.
   */
  resolveChannelRuntime?: () => ChannelRuntimeSurface | Promise<ChannelRuntimeSurface>;
  /**
   * Lightweight channel runtime used for bundled channel startup. Bundled
   * channels only need `runtimeContexts` while booting, so this avoids pulling
   * the full reply/routing/session runtime graph onto the critical path.
   */
  resolveStartupChannelRuntime?: () => ChannelRuntimeSurface | Promise<ChannelRuntimeSurface>;
  startupTrace?: GatewayStartupTrace;
};

type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
};

type StopChannelOptions = {
  manual?: boolean;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string, opts?: StopChannelOptions) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const {
    getRuntimeConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime,
    resolveChannelRuntime,
    resolveStartupChannelRuntime,
    startupTrace,
  } = opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  // Tracks restart attempts per channel:account. Reset on successful start.
  const restartAttempts = new Map<string, number>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();
  const recoveryStopTimedOut = new Set<string>();

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;
  const ensureChannelLog = (channelId: ChannelId): SubsystemLogger => {
    channelLogs[channelId] ??= createSubsystemLogger("channels").child(channelId);
    return channelLogs[channelId];
  };
  const ensureChannelRuntime = (channelId: ChannelId): RuntimeEnv => {
    channelRuntimeEnvs[channelId] ??= runtimeForLogger(ensureChannelLog(channelId));
    return channelRuntimeEnvs[channelId];
  };
  const formatLogContext = (context: Record<string, unknown>): string => {
    try {
      return JSON.stringify(context);
    } catch (error) {
      return JSON.stringify({ logContextError: formatErrorMessage(error) });
    }
  };

  const resolveAccountHealthMonitorOverride = (
    channelConfig: ChannelHealthMonitorConfig | undefined,
    accountId: string,
  ): boolean | undefined => {
    if (!channelConfig?.accounts) {
      return undefined;
    }
    const direct = resolveAccountEntry(channelConfig.accounts, accountId);
    if (typeof direct?.healthMonitor?.enabled === "boolean") {
      return direct.healthMonitor.enabled;
    }

    const normalizedAccountId = normalizeOptionalAccountId(accountId);
    if (!normalizedAccountId) {
      return undefined;
    }
    const match = resolveNormalizedAccountEntry(
      channelConfig.accounts,
      normalizedAccountId,
      normalizeAccountId,
    );
    if (typeof match?.healthMonitor?.enabled !== "boolean") {
      return undefined;
    }
    return match.healthMonitor.enabled;
  };

  const isHealthMonitorEnabled = (channelId: ChannelId, accountId: string): boolean => {
    const cfg = getRuntimeConfig();
    const channelConfig = cfg.channels?.[channelId] as ChannelHealthMonitorConfig | undefined;
    const accountOverride = resolveAccountHealthMonitorOverride(channelConfig, accountId);
    const channelOverride = channelConfig?.healthMonitor?.enabled;

    if (typeof accountOverride === "boolean") {
      return accountOverride;
    }

    if (typeof channelOverride === "boolean") {
      return channelOverride;
    }

    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return true;
    }
    try {
      // Probe only: health-monitor config is read directly from raw channel config above.
      // This call exists solely to fail closed if resolver-side config loading is broken.
      plugin.config.resolveAccount(cfg, accountId);
    } catch (err) {
      ensureChannelLog(channelId).warn?.(
        `[${channelId}:${accountId}] health-monitor: failed to resolve account; skipping monitor (${formatErrorMessage(err)})`,
      );
      return false;
    }

    return true;
  };

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const getChannelRuntime = async (
    channelId: ChannelId,
  ): Promise<ChannelRuntimeSurface | undefined> => {
    if (channelRuntime) {
      return channelRuntime;
    }
    if (getLoadedChannelPluginOrigin(channelId) === "bundled") {
      const startupRuntime = await resolveStartupChannelRuntime?.();
      if (startupRuntime) {
        return startupRuntime;
      }
    }
    return await resolveChannelRuntime?.();
  };
  const measureStartup = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    return startupTrace ? startupTrace.measure(name, run) : await run();
  };

  const evictStaleChannelAccountState = (
    channelId: ChannelId,
    store: ChannelRuntimeStore,
    accountIds: readonly string[],
  ) => {
    const activeAccountIds = new Set(accountIds);
    for (const id of store.runtimes.keys()) {
      if (
        activeAccountIds.has(id) ||
        store.aborts.has(id) ||
        store.starting.has(id) ||
        store.tasks.has(id)
      ) {
        continue;
      }
      ensureChannelLog(channelId).info?.(
        `[${id}] evicting stale channel runtime state ${formatLogContext({
          activeAccountIds: accountIds,
          hadRestartAttempts: restartAttempts.has(restartKey(channelId, id)),
          wasManuallyStopped: manuallyStopped.has(restartKey(channelId, id)),
        })}`,
      );
      store.runtimes.delete(id);
      restartAttempts.delete(restartKey(channelId, id));
      manuallyStopped.delete(restartKey(channelId, id));
    }
  };

  const startChannelInternal = async (
    channelId: ChannelId,
    accountId?: string,
    opts: StartChannelOptions = {},
  ) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      ensureChannelLog(channelId).debug?.(
        `[${channelId}] channel start skipped: no gateway startAccount ${formatLogContext({
          hasPlugin: Boolean(plugin),
          origin: getLoadedChannelPluginOrigin(channelId),
        })}`,
      );
      return;
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = opts;
    const cfg = getRuntimeConfig();
    resetDirectoryCache({ channel: channelId, accountId });
    const store = getStore(channelId);
    const accountIds = accountId
      ? [accountId]
      : await measureStartup(`channels.${channelId}.list-accounts`, () =>
          plugin.config.listAccountIds(cfg),
        );
    if (!accountId) {
      evictStaleChannelAccountState(channelId, store, accountIds);
    }
    const log = ensureChannelLog(channelId);
    log.info?.(
      `[${channelId}] channel start plan ${formatLogContext({
        requestedAccountId: accountId ?? null,
        accountIds,
        accountCount: accountIds.length,
        origin: getLoadedChannelPluginOrigin(channelId),
        preserveRestartAttempts,
        preserveManualStop,
        storeAborts: store.aborts.size,
        storeStarting: store.starting.size,
        storeTasks: store.tasks.size,
        storeRuntimes: store.runtimes.size,
        hasChannelRuntime: Boolean(channelRuntime || resolveChannelRuntime),
        hasStartupRuntime: Boolean(resolveStartupChannelRuntime),
      })}`,
    );
    if (accountIds.length === 0) {
      log.info?.(`[${channelId}] channel start skipped: no configured account ids`);
      return;
    }

    const startup = await runTasksWithConcurrency({
      limit: CHANNEL_STARTUP_CONCURRENCY,
      tasks: accountIds.map((id) => async () => {
        const log = ensureChannelLog(channelId);
        const rKey = restartKey(channelId, id);
        log.info?.(
          `[${id}] channel account startup enter ${formatLogContext({
            channelId,
            origin: getLoadedChannelPluginOrigin(channelId),
            preserveRestartAttempts,
            preserveManualStop,
            restartAttempts: restartAttempts.get(rKey) ?? 0,
            manuallyStopped: manuallyStopped.has(rKey),
            storeHasTask: store.tasks.has(id),
            storeHasStarting: store.starting.has(id),
            storeHasAbort: store.aborts.has(id),
            storeRuntime: store.runtimes.get(id) ?? null,
          })}`,
        );
        if (store.tasks.has(id)) {
          log.info?.(`[${id}] channel account startup skipped: task already running`);
          return;
        }
        const existingStart = store.starting.get(id);
        if (existingStart) {
          log.info?.(`[${id}] channel account startup waiting for existing start gate`);
          await existingStart;
          log.info?.(`[${id}] channel account startup existing start gate settled`);
          return;
        }

        let resolveStart: (() => void) | undefined;
        const startGate = new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
        store.starting.set(id, startGate);

        // Reserve the account before the first await so overlapping start calls
        // cannot race into duplicate provider boots for the same account.
        const abort = new AbortController();
        store.aborts.set(id, abort);
        let handedOffTask = false;
        const runtime = ensureChannelRuntime(channelId);
        let scopedChannelRuntime: ReturnType<typeof createTaskScopedChannelRuntime> | null = null;
        let channelRuntimeForTask: ChannelRuntimeSurface | undefined;
        let stopApprovalBootstrap: () => Promise<void> = async () => {};
        const stopTaskScopedApprovalRuntime = async () => {
          const scopedRuntime = scopedChannelRuntime;
          scopedChannelRuntime = null;
          const stopBootstrap = stopApprovalBootstrap;
          stopApprovalBootstrap = async () => {};
          scopedRuntime?.dispose();
          await stopBootstrap();
        };
        const cleanupTaskScopedApprovalRuntime = async (label: string) => {
          try {
            await stopTaskScopedApprovalRuntime();
          } catch (error) {
            log.error?.(`[${id}] ${label}: ${formatErrorMessage(error)}`);
          }
        };

        try {
          log.info?.(`[${id}] resolving channel account config`);
          const account = plugin.config.resolveAccount(cfg, id);
          log.info?.(
            `[${id}] resolved channel account config ${formatLogContext({
              accountType: typeof account,
              accountKeys:
                account && typeof account === "object" ? Object.keys(account).toSorted() : [],
            })}`,
          );
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          log.info?.(`[${id}] channel account enabled check ${formatLogContext({ enabled })}`);
          if (!enabled) {
            const reason = plugin.config.disabledReason?.(account, cfg) ?? "disabled";
            log.info?.(
              `[${id}] channel account startup skipped: disabled ${formatLogContext({ reason })}`,
            );
            setRuntime(channelId, id, {
              accountId: id,
              enabled: false,
              configured: true,
              running: false,
              restartPending: false,
              lastError: reason,
            });
            return;
          }

          let configured = true;
          if (plugin.config.isConfigured) {
            log.info?.(`[${id}] channel account configured check begin`);
            configured = await measureStartup(`channels.${channelId}.is-configured`, () =>
              plugin.config.isConfigured!(account, cfg),
            );
          }
          log.info?.(
            `[${id}] channel account configured check ${formatLogContext({ configured })}`,
          );
          if (!configured) {
            const reason = plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
            log.info?.(
              `[${id}] channel account startup skipped: not configured ${formatLogContext({ reason })}`,
            );
            setRuntime(channelId, id, {
              accountId: id,
              enabled: true,
              configured: false,
              running: false,
              restartPending: false,
              lastError: reason,
            });
            return;
          }

          if (!preserveManualStop) {
            const hadManualStop = manuallyStopped.delete(rKey);
            log.info?.(
              `[${id}] channel manual-stop state cleared ${formatLogContext({ hadManualStop })}`,
            );
          }

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            log.info?.(
              `[${id}] channel account startup skipped: aborted or manually stopped ${formatLogContext(
                {
                  aborted: abort.signal.aborted,
                  manuallyStopped: manuallyStopped.has(rKey),
                },
              )}`,
            );
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              restartPending: false,
              lastStopAt: Date.now(),
            });
            return;
          }

          log.info?.(`[${id}] channel runtime resolution begin`);
          scopedChannelRuntime = await measureStartup(`channels.${channelId}.runtime`, async () =>
            createTaskScopedChannelRuntime({
              channelRuntime: await getChannelRuntime(channelId),
            }),
          );
          channelRuntimeForTask = scopedChannelRuntime.channelRuntime;
          log.info?.(
            `[${id}] channel runtime resolution complete ${formatLogContext({
              hasChannelRuntimeForTask: Boolean(channelRuntimeForTask),
            })}`,
          );

          if (!preserveRestartAttempts) {
            const hadRestartAttempts = restartAttempts.delete(rKey);
            log.info?.(
              `[${id}] channel restart-attempt state cleared ${formatLogContext({ hadRestartAttempts })}`,
            );
          }
          try {
            log.info?.(`[${id}] native approval bootstrap begin`);
            stopApprovalBootstrap = await measureStartup(
              `channels.${channelId}.approval-bootstrap`,
              () =>
                startChannelApprovalHandlerBootstrap({
                  plugin,
                  cfg,
                  accountId: id,
                  channelRuntime: channelRuntimeForTask,
                  logger: log,
                }),
            );
            log.info?.(`[${id}] native approval bootstrap complete`);
          } catch (error) {
            log.error?.(`[${id}] native approval bootstrap failed: ${formatErrorMessage(error)}`);
          }
          log.info?.(`[${id}] marking channel account running before provider handoff`);
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: true,
            running: true,
            restartPending: false,
            lastStartAt: Date.now(),
            lastError: null,
            reconnectAttempts: preserveRestartAttempts ? (restartAttempts.get(rKey) ?? 0) : 0,
          });
          const task = Promise.resolve().then(() => {
            log.info?.(`[${id}] channel provider startAccount begin`);
            return measureStartup(`channels.${channelId}.start-account`, () =>
              startAccount({
                cfg,
                accountId: id,
                account,
                runtime,
                abortSignal: abort.signal,
                log,
                getStatus: () => getRuntime(channelId, id),
                setStatus: (next) => setRuntime(channelId, id, next),
                ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
              }),
            );
          });
          const trackedPromise = task
            .then(() => {
              log.info?.(`[${id}] channel provider startAccount resolved`);
              if (abort.signal.aborted || manuallyStopped.has(rKey)) {
                return;
              }
              const message = "channel exited without an error";
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(`[${id}] ${message}`);
            })
            .catch((err) => {
              const message = formatErrorMessage(err);
              const stack = err instanceof Error && err.stack ? err.stack : null;
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(
                `[${id}] channel exited: ${message}${stack ? ` stack=${stack}` : ""} ${formatLogContext(
                  {
                    restartAttempts: restartAttempts.get(rKey) ?? 0,
                    aborted: abort.signal.aborted,
                    manuallyStopped: manuallyStopped.has(rKey),
                  },
                )}`,
              );
            })
            .finally(async () => {
              log.info?.(`[${id}] channel cleanup begin`);
              await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
              log.info?.(`[${id}] channel cleanup complete`);
              setRuntime(channelId, id, {
                accountId: id,
                running: false,
                lastStopAt: Date.now(),
              });
            })
            .then(async () => {
              if (manuallyStopped.has(rKey)) {
                log.info?.(`[${id}] channel restart skipped: manually stopped`);
                return;
              }
              const attempt = (restartAttempts.get(rKey) ?? 0) + 1;
              restartAttempts.set(rKey, attempt);
              if (attempt > MAX_RESTART_ATTEMPTS) {
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: attempt,
                });
                log.error?.(`[${id}] giving up after ${MAX_RESTART_ATTEMPTS} restart attempts`);
                return;
              }
              const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, attempt);
              log.info?.(
                `[${id}] auto-restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`,
              );
              setRuntime(channelId, id, {
                accountId: id,
                restartPending: true,
                reconnectAttempts: attempt,
              });
              const recoveryRestartSleepAbort = recoveryStopTimedOut.has(rKey)
                ? new AbortController()
                : undefined;
              if (recoveryRestartSleepAbort) {
                store.aborts.set(id, recoveryRestartSleepAbort);
              }
              try {
                const restartSleepAbort = recoveryRestartSleepAbort?.signal ?? abort.signal;
                log.info?.(
                  `[${id}] channel restart sleep begin ${formatLogContext({
                    delayMs,
                    recoveryStopTimedOut: Boolean(recoveryRestartSleepAbort),
                  })}`,
                );
                await sleepWithAbort(delayMs, restartSleepAbort);
                log.info?.(`[${id}] channel restart sleep complete`);
                if (manuallyStopped.has(rKey)) {
                  log.info?.(`[${id}] channel restart cancelled after sleep: manually stopped`);
                  recoveryStopTimedOut.delete(rKey);
                  return;
                }
                recoveryStopTimedOut.delete(rKey);
                if (store.tasks.get(id) === trackedPromise) {
                  store.tasks.delete(id);
                }
                if (store.aborts.get(id) === (recoveryRestartSleepAbort ?? abort)) {
                  store.aborts.delete(id);
                }
                log.info?.(`[${id}] channel restart invoking startChannelInternal`);
                await startChannelInternal(channelId, id, {
                  preserveRestartAttempts: true,
                  preserveManualStop: true,
                });
              } catch (error) {
                log.warn?.(
                  `[${id}] channel restart sleep/start interrupted: ${formatErrorMessage(error)}`,
                );
                // abort or startup failure - next crash will retry
              } finally {
                if (recoveryRestartSleepAbort) {
                  recoveryStopTimedOut.delete(rKey);
                  if (store.aborts.get(id) === recoveryRestartSleepAbort) {
                    store.aborts.delete(id);
                  }
                }
              }
            })
            .finally(() => {
              log.info?.(
                `[${id}] channel tracked task finalizer ${formatLogContext({
                  storeTaskMatches: store.tasks.get(id) === trackedPromise,
                  storeAbortMatches: store.aborts.get(id) === abort,
                })}`,
              );
              if (store.tasks.get(id) === trackedPromise) {
                store.tasks.delete(id);
              }
              if (store.aborts.get(id) === abort) {
                store.aborts.delete(id);
              }
            });
          handedOffTask = true;
          store.tasks.set(id, trackedPromise);
          log.info?.(`[${id}] channel provider task handed off to supervisor`);
        } catch (error) {
          const message = formatErrorMessage(error);
          const stack = error instanceof Error && error.stack ? error.stack : null;
          log.error?.(
            `[${id}] channel startup failed before provider handoff: ${message}${stack ? ` stack=${stack}` : ""}`,
          );
          if (!handedOffTask) {
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              restartPending: false,
              lastError: message,
            });
          }
          throw error;
        } finally {
          resolveStart?.();
          if (store.starting.get(id) === startGate) {
            store.starting.delete(id);
          }
          if (!handedOffTask) {
            await cleanupTaskScopedApprovalRuntime("channel startup cleanup failed");
          }
          if (!handedOffTask && store.aborts.get(id) === abort) {
            store.aborts.delete(id);
          }
          log.info?.(
            `[${id}] channel startup finalizer ${formatLogContext({
              handedOffTask,
              storeHasAbort: store.aborts.has(id),
              storeHasStarting: store.starting.has(id),
              storeHasTask: store.tasks.has(id),
            })}`,
          );
        }
      }),
    });
    if (startup.hasError) {
      log.error?.(
        `[${channelId}] channel startup batch failed: ${formatErrorMessage(startup.firstError)}`,
      );
      throw startup.firstError;
    }
    log.info?.(`[${channelId}] channel startup batch complete`);
  };

  const startChannel = async (channelId: ChannelId, accountId?: string) => {
    await startChannelInternal(channelId, accountId);
  };

  const stopChannel = async (
    channelId: ChannelId,
    accountId?: string,
    opts: StopChannelOptions = {},
  ) => {
    const manual = opts.manual ?? true;
    const plugin = getChannelPlugin(channelId);
    const store = getStore(channelId);
    const log = ensureChannelLog(channelId);
    log.info?.(
      `[${channelId}] channel stop requested ${formatLogContext({
        accountId: accountId ?? null,
        manual,
        hasPlugin: Boolean(plugin),
        hasStopAccount: Boolean(plugin?.gateway?.stopAccount),
        storeAborts: store.aborts.size,
        storeStarting: store.starting.size,
        storeTasks: store.tasks.size,
      })}`,
    );
    // Fast path: nothing running and no explicit plugin shutdown hook to run.
    if (!plugin?.gateway?.stopAccount && store.aborts.size === 0 && store.tasks.size === 0) {
      log.info?.(`[${channelId}] channel stop skipped: no running accounts or stop hook`);
      return;
    }
    const cfg = getRuntimeConfig();
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.starting.keys(),
      ...store.tasks.keys(),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    log.info?.(
      `[${channelId}] channel stop plan ${formatLogContext({
        knownIds: Array.from(knownIds.values()),
        knownCount: knownIds.size,
      })}`,
    );
    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) {
          log.info?.(`[${id}] channel stop skipped: no account task/abort/stop hook`);
          return;
        }
        const rKey = restartKey(channelId, id);
        if (manual) {
          manuallyStopped.add(rKey);
        }
        log.info?.(
          `[${id}] channel stop account begin ${formatLogContext({
            manual,
            hadAbort: Boolean(abort),
            hadTask: Boolean(task),
            hasStopAccount: Boolean(plugin?.gateway?.stopAccount),
          })}`,
        );
        abort?.abort();
        const runtime = ensureChannelRuntime(channelId);
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          log.info?.(`[${id}] channel stopAccount hook begin`);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime,
            abortSignal: abort?.signal ?? new AbortController().signal,
            log,
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
          log.info?.(`[${id}] channel stopAccount hook complete`);
        }
        const stoppedCleanly = await waitForChannelStopGracefully(
          task,
          CHANNEL_STOP_ABORT_TIMEOUT_MS,
        );
        if (!stoppedCleanly) {
          log.warn?.(
            `[${id}] channel stop exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms after abort; continuing shutdown`,
          );
          setRuntime(channelId, id, {
            accountId: id,
            running: manual,
            restartPending: !manual,
            lastError: `channel stop timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
          });
          if (!manual) {
            recoveryStopTimedOut.add(rKey);
          }
          return;
        }
        recoveryStopTimedOut.delete(rKey);
        store.aborts.delete(id);
        store.tasks.delete(id);
        log.info?.(`[${id}] channel stop account complete`);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          restartPending: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startChannels = async () => {
    const plugins = [...listChannelPlugins()];
    createSubsystemLogger("channels").info?.(
      `[channels] starting all channel plugins ${formatLogContext({
        pluginIds: plugins.map((plugin) => plugin.id),
        pluginCount: plugins.length,
        concurrency: CHANNEL_STARTUP_CONCURRENCY,
      })}`,
    );
    await runTasksWithConcurrency({
      limit: CHANNEL_STARTUP_CONCURRENCY,
      tasks: plugins.map((plugin) => async () => {
        try {
          await measureStartup(`channels.${plugin.id}.start`, () => startChannel(plugin.id));
        } catch (err) {
          ensureChannelLog(plugin.id).error?.(
            `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
          );
        }
      }),
    });
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = getRuntimeConfig();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    const next: ChannelAccountSnapshot = {
      accountId: resolvedId,
      running: false,
      restartPending: false,
      lastError: cleared ? "logged out" : current.lastError,
    };
    if (typeof current.connected === "boolean") {
      next.connected = false;
    }
    setRuntime(channelId, resolvedId, next);
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const cfg = getRuntimeConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        next.enabled = enabled;
        applyDescribedAccountFields(next, described);
        const configured = described?.configured;
        if (!next.running) {
          if (!enabled) {
            next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
          } else if (configured === false) {
            next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
          }
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
      channels[plugin.id] = defaultAccount;
      channelAccounts[plugin.id] = accounts;
    }
    return { channels, channelAccounts };
  };

  const isManuallyStopped_ = (channelId: ChannelId, accountId: string): boolean => {
    return manuallyStopped.has(restartKey(channelId, accountId));
  };

  const resetRestartAttempts_ = (channelId: ChannelId, accountId: string): void => {
    restartAttempts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStopped_,
    resetRestartAttempts: resetRestartAttempts_,
    isHealthMonitorEnabled,
  };
}
