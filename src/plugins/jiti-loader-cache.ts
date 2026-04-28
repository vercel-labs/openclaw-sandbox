import { createRequire } from "node:module";
import type { createJiti } from "jiti";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderJitiCacheKey,
  resolvePluginLoaderJitiConfig,
} from "./sdk-alias.js";

export type PluginJitiLoader = ReturnType<typeof createJiti>;
export type PluginJitiLoaderFactory = typeof createJiti;
export type PluginJitiLoaderCache = Map<string, PluginJitiLoader>;

let cachedDefaultCreateJiti: PluginJitiLoaderFactory | undefined;
function getDefaultCreateJiti(): PluginJitiLoaderFactory {
  if (cachedDefaultCreateJiti) {
    return cachedDefaultCreateJiti;
  }
  // Load jiti via CJS require so the bundle has a single transport for jiti.
  // See facade-loader.ts for the dual-load incident this avoids.
  const jitiModule = createRequire(import.meta.url)("jiti") as {
    createJiti: PluginJitiLoaderFactory;
  };
  cachedDefaultCreateJiti = jitiModule.createJiti;
  return cachedDefaultCreateJiti;
}

export function getCachedPluginJitiLoader(params: {
  cache: PluginJitiLoaderCache;
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  jitiFilename?: string;
  createLoader?: PluginJitiLoaderFactory;
  aliasMap?: Record<string, string>;
  tryNative?: boolean;
  cacheScopeKey?: string;
}): PluginJitiLoader {
  const defaultConfig =
    params.aliasMap || typeof params.tryNative === "boolean"
      ? resolvePluginLoaderJitiConfig({
          modulePath: params.modulePath,
          argv1: params.argvEntry ?? process.argv[1],
          moduleUrl: params.importerUrl,
          ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
        })
      : null;
  const resolved = defaultConfig
    ? {
        tryNative: params.tryNative ?? defaultConfig.tryNative,
        aliasMap: params.aliasMap ?? defaultConfig.aliasMap,
      }
    : resolvePluginLoaderJitiConfig({
        modulePath: params.modulePath,
        argv1: params.argvEntry ?? process.argv[1],
        moduleUrl: params.importerUrl,
        ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
      });
  const { tryNative, aliasMap } = resolved;
  const cacheKey = createPluginLoaderJitiCacheKey({
    tryNative,
    aliasMap,
  });
  const scopedCacheKey = `${params.jitiFilename ?? params.modulePath}::${params.cacheScopeKey ?? cacheKey}`;
  const cached = params.cache.get(scopedCacheKey);
  if (cached) {
    return cached;
  }
  const loader = (params.createLoader ?? getDefaultCreateJiti())(
    params.jitiFilename ?? params.modulePath,
    {
      ...buildPluginLoaderJitiOptions(aliasMap),
      tryNative,
    },
  );
  params.cache.set(scopedCacheKey, loader);
  return loader;
}
