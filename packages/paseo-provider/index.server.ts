import type { PluginServerContext } from '@getpaseo/plugin/server';
import { createDeepseekHarnessProvider } from './src/provider.js';

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDeepseekHarnessProvider());
  return () => {};
}
