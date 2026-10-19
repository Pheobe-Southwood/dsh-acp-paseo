import type { PluginServerContext } from '@getpaseo/plugin/server';
import { createDeepseekHarnessProvider } from './server/provider.js';

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDeepseekHarnessProvider());
  return () => {};
}
